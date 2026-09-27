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
