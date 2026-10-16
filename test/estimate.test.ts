import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { createLedgerAdmission } from "../src/budget/admission.ts";
import { parseCredits, scaleCredits, tokenCost } from "../src/budget/credits.ts";
import {
  createEstimatingMeter,
  estimateInputTokens,
  estimateSettings,
  type Rates,
} from "../src/budget/estimate.ts";
import { CreditLedger } from "../src/budget/ledger.ts";
import { parseConfig } from "../src/config.ts";
import { createGuardedStreams } from "../src/pi/guarded-streams.ts";
import { puzzleId } from "../src/state/ids.ts";
import { FAKE_MODEL, message, responseStream } from "./support/fake-pi.ts";

const c = parseCredits;
const config = parseConfig({
  version: 1,
  event: { year: 2025 },
  storageDir: "/synthetic",
  aoc: { sessionCookieFile: "/synthetic/cookie" },
  creditPools: [
    { id: "pool", provider: "anthropic", unit: "usd", limits: { event: "10", perPuzzle: "10" } },
  ],
  subscriptions: [
    {
      id: "sub",
      provider: "anthropic",
      credentialFile: "/synthetic/key",
      model: FAKE_MODEL.id,
      creditPool: "pool",
      limits: { event: "10", perPuzzle: "10" },
      estimate: {
        pricing: "synthetic-2026",
        rates: { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" },
        assumedMaxOutputTokens: 2000,
      },
    },
  ],
});
const subscription = config.subscriptions[0];
assert.ok(subscription);
const settings = estimateSettings(subscription);
assert.ok(settings);
const context = () =>
  normalizeContext({ messages: [{ role: "user", content: "synthetic puzzle", timestamp: 1 }] });
const request = (maxTokens?: number) => ({
  id: "r",
  model: FAKE_MODEL,
  context: context(),
  options: maxTokens ? { maxTokens } : {},
  signal: undefined,
});

test("estimates are padded, price input at the higher cache-write rate, and respect output caps", () => {
  const inputTokens = estimateInputTokens(request());
  const enforced = createEstimatingMeter({ settings, enforcesMaxTokens: true });
  const expected = scaleCredits(
    (tokenCost(c("3.75"), inputTokens) + tokenCost(c("15"), 100)) as never,
    c("1.5"),
  );
  assert.equal(enforced.maxCharge(request(100)), expected);
  const unenforced = createEstimatingMeter({ settings, enforcesMaxTokens: false });
  assert.ok(unenforced.maxCharge(request(100)) > expected, "assumed 2000 output tokens");
  assert.equal(settings.safetyFactor, c("1.5"), "default safety factor");
});

test("actual charges prefer provider figures, then usage, then the estimate", async () => {
  const withUsage = message({
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheWrite: 0,
      totalTokens: 6200,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const meter = createEstimatingMeter({ settings, enforcesMaxTokens: true });
  const derived = await meter.actualCharge(withUsage, c("1"));
  assert.equal(derived.source, "derived");
  assert.equal(derived.credits, c("0.0075"), "1000×3 + 200×15 + 5000×0.3 per million");
  assert.equal(derived.receipt, "usage:synthetic-2026:1000/200/5000/0");
  const empty = message({
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: withUsage.usage.cost,
    },
  });
  assert.deepEqual(await meter.actualCharge(empty, c("0.5")), {
    credits: c("0.5"),
    receipt: "estimate:synthetic-2026",
    source: "estimated",
  });
  const failedEarly = message({ stopReason: "error", content: [], usage: empty.usage });
  assert.deepEqual(await meter.actualCharge(failedEarly, c("0.5")), {
    credits: 0n,
    receipt: "error-before-output",
    source: "estimated",
  });
  const reporting = createEstimatingMeter({
    settings,
    enforcesMaxTokens: true,
    providerCharge: async () => ({ credits: c("0.01"), receipt: "provider:abc" }),
  });
  assert.equal((await reporting.actualCharge(withUsage, c("1"))).source, "provider");
});

test("long-context settings validate known rates and retain backward-compatible flat configs", () => {
  const estimate = subscription.estimate;
  assert.ok(estimate);
  const withTier = (tier: unknown) => ({
    ...config,
    subscriptions: [{ ...subscription, estimate: { ...estimate, longContext: tier } }],
  });
  const tier = {
    inputTokensAbove: 1000,
    rates: { input: "6", output: "22.5", cacheRead: "0.6", cacheWrite: "7.5" },
  };
  const parsed = parseConfig(withTier(tier));
  assert.deepEqual(estimateSettings(parsed.subscriptions[0] ?? subscription)?.longContext, {
    inputTokensAbove: 1000,
    rates: { input: c("6"), output: c("22.5"), cacheRead: c("0.6"), cacheWrite: c("7.5") },
  });
  assert.equal(settings.longContext, undefined);
  for (const invalid of [
    { ...tier, inputTokensAbove: 0 },
    { ...tier, inputTokensAbove: 1.5 },
    { ...tier, rates: { ...tier.rates, output: "0" } },
    { ...tier, rates: { ...tier.rates, input: "0" } },
    { ...tier, rates: { ...tier.rates, input: "invalid" } },
    { ...tier, rates: { ...tier.rates, unknown: "1" } },
  ])
    assert.throws(() => parseConfig(withTier(invalid)), /Invalid configuration/);
});

const tieredSettings = {
  ...settings,
  longContext: {
    inputTokensAbove: 1000,
    rates: { input: c("6"), output: c("22.5"), cacheRead: c("0.6"), cacheWrite: c("7.5") },
  },
};

test("tiered reservations and streaming cutoffs use worst-case rates even for short prompts", () => {
  const meter = createEstimatingMeter({ settings: tieredSettings, enforcesMaxTokens: true });
  const expected = scaleCredits(
    (tokenCost(c("7.5"), estimateInputTokens(request())) + tokenCost(c("22.5"), 100)) as never,
    c("1.5"),
  );
  assert.equal(meter.maxCharge(request(100)), expected);
  const partial = message({ content: [{ type: "text", text: "x".repeat(300) }] });
  assert.equal(
    meter.partialCharge?.(partial, request(100)),
    tokenCost(c("7.5"), estimateInputTokens(request())) + tokenCost(c("22.5"), 100),
  );
  const nonMonotonic = createEstimatingMeter({
    settings: {
      ...tieredSettings,
      rates: { ...settings.rates, cacheRead: c("9"), output: c("30") },
    },
    enforcesMaxTokens: true,
  });
  assert.equal(
    nonMonotonic.maxCharge(request(100)),
    scaleCredits(
      (tokenCost(c("9"), estimateInputTokens(request())) + tokenCost(c("30"), 100)) as never,
      c("1.5"),
    ),
  );
  assert.throws(
    () =>
      createEstimatingMeter({
        settings: {
          ...tieredSettings,
          longContext: {
            ...tieredSettings.longContext,
            rates: { ...tieredSettings.longContext.rates, output: c("0") },
          },
        },
        enforcesMaxTokens: true,
      }),
    /zero/,
  );
});

test("tiered settlement selects the exact reported input boundary including both cache categories", async () => {
  const meter = createEstimatingMeter({ settings: tieredSettings, enforcesMaxTokens: true });
  for (const [input, cacheRead, cacheWrite, isLong] of [
    [900, 100, 0, false],
    [900, 101, 0, true],
    [900, 100, 1, true],
    [1000, 0, 0, false],
    [1001, 0, 0, true],
  ] as const) {
    const response = message();
    response.usage = {
      ...response.usage,
      input,
      cacheRead,
      cacheWrite,
      output: 200,
      reasoning: 150,
    };
    const actual = await meter.actualCharge(response, c("1"));
    const rates: Rates = isLong ? tieredSettings.longContext.rates : settings.rates;
    assert.equal(
      actual.credits,
      tokenCost(rates.input, input) +
        tokenCost(rates.cacheRead, cacheRead) +
        tokenCost(rates.cacheWrite, cacheWrite) +
        tokenCost(rates.output, 200),
    );
    assert.equal(actual.source, "derived");
    assert.match(actual.receipt, /^usage:synthetic-2026:/);
  }
  const provider = createEstimatingMeter({
    settings: tieredSettings,
    enforcesMaxTokens: true,
    providerCharge: async () => ({ credits: c("0.02"), receipt: "provider:tier" }),
  });
  assert.deepEqual(await provider.actualCharge(message(), c("1")), {
    credits: c("0.02"),
    receipt: "provider:tier",
    source: "provider",
  });
});

test("a response streaming past its estimate is cut off and settled as estimated", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "boc-cutoff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = await CreditLedger.open({ directory: join(dir, "ledger"), config });
  t.after(() => ledger.close().catch(() => {}));
  const admission = createLedgerAdmission({
    ledger,
    subscription: "sub",
    model: FAKE_MODEL.id,
    puzzle: puzzleId(1),
    meter: createEstimatingMeter({ settings, enforcesMaxTokens: true }),
  });
  let aborted = false;
  let deltas = 0;
  const runaway = (_m: unknown, _c: unknown, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();
    const partial: AssistantMessage = message({ content: [{ type: "text", text: "" }] });
    stream.push({ type: "start", partial });
    void (async () => {
      for (let i = 0; i < 1000 && !options?.signal?.aborted; i++) {
        const block = partial.content[0];
        if (block?.type === "text") block.text += "x".repeat(300);
        deltas++;
        stream.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(300), partial });
        await new Promise((r) => setImmediate(r));
      }
      aborted = options?.signal?.aborted === true;
      stream.end();
    })();
    return stream;
  };
  const guard = createGuardedStreams({
    model: FAKE_MODEL,
    admission,
    transport: { stream: runaway, streamSimple: runaway },
  });
  const result = await guard.stream(FAKE_MODEL, context(), { maxTokens: 50 }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /exceeded its credit estimate/);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(aborted, "the upstream request was aborted");
  assert.ok(deltas < 100, `stopped early (${deltas} deltas)`);
  const status = ledger.status([puzzleId(1)]);
  assert.equal(status.held.length, 0, "settled, not held");
  const journal = await readFile(join(dir, "ledger/journal.jsonl"), "utf8");
  assert.match(journal, /"evidence":"cutoff:estimate","source":"estimated"/);
  // Not a fault: the guard keeps working for the next call.
  const normal = createGuardedStreams({
    model: FAKE_MODEL,
    admission,
    transport: {
      stream: () => responseStream(message()),
      streamSimple: () => responseStream(message()),
    },
  });
  assert.equal((await normal.stream(FAKE_MODEL, context()).result()).stopReason, "stop");
  assert.equal(
    (await guard.stream(FAKE_MODEL, context()).result()).stopReason,
    "error",
    "same guard, runaway again",
  );
  assert.equal(ledger.status().held.length, 0);
});

test("slow and stalled responses stop at their time limits and settle like the cutoff", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "boc-timeout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = await CreditLedger.open({ directory: join(dir, "ledger"), config });
  t.after(() => ledger.close().catch(() => {}));
  const admission = createLedgerAdmission({
    ledger,
    subscription: "sub",
    model: FAKE_MODEL.id,
    puzzle: puzzleId(1),
    meter: createEstimatingMeter({ settings, enforcesMaxTokens: true }),
  });
  let mode: "slow" | "stalled" | "normal" = "slow";
  let aborted = false;
  const upstream = (_m: unknown, _c: unknown, options?: { signal?: AbortSignal }) => {
    if (mode === "normal") return responseStream(message());
    const stream = createAssistantMessageEventStream();
    const partial: AssistantMessage = message({ content: [{ type: "text", text: "" }] });
    stream.push({ type: "start", partial });
    options?.signal?.addEventListener("abort", () => {
      aborted = true;
    });
    if (mode === "slow") {
      void (async () => {
        // Tiny deltas far below the credit estimate, forever until aborted.
        while (!options?.signal?.aborted) {
          const block = partial.content[0];
          if (block?.type === "text") block.text += "y";
          stream.push({ type: "text_delta", contentIndex: 0, delta: "y", partial });
          await new Promise((r) => setTimeout(r, 5));
        }
        stream.end();
      })();
    }
    // "stalled": no further events and it ignores the abort; the guard must not hang.
    return stream;
  };
  const cutoffs: string[] = [];
  const guard = createGuardedStreams({
    model: FAKE_MODEL,
    admission,
    transport: { stream: upstream, streamSimple: upstream },
    maxResponseMs: 150,
    stallMs: 60,
    onCutoff: (partial, reason) => {
      const block = partial.content[0];
      cutoffs.push(`${reason} ${block?.type === "text" ? block.text.length > 0 : "?"}`);
    },
  });
  const slow = await guard.stream(FAKE_MODEL, context(), { maxTokens: 50 }).result();
  assert.equal(slow.errorMessage, "Response stopped: it exceeded its time limit.");
  assert.ok(aborted, "the upstream request was aborted");
  mode = "stalled";
  const stalled = await guard.stream(FAKE_MODEL, context(), { maxTokens: 50 }).result();
  assert.equal(stalled.errorMessage, "Response stopped: the stream stalled.");
  assert.deepEqual(cutoffs, [
    "Response stopped: it exceeded its time limit. true",
    "Response stopped: the stream stalled. false",
  ]);
  assert.equal(ledger.status().held.length, 0, "both settled, not held");
  const journal = await readFile(join(dir, "ledger/journal.jsonl"), "utf8");
  assert.equal(journal.match(/"evidence":"cutoff:estimate"/g)?.length, 2);
  mode = "normal";
  assert.equal(
    (await guard.stream(FAKE_MODEL, context()).result()).stopReason,
    "stop",
    "not a fault: the same guard keeps working",
  );
});
