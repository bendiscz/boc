import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { UNLOCK_RETRY_DELAYS_MS } from "../src/aoc/calendar.ts";
import { type AocClient, AocError } from "../src/aoc/client.ts";
import { AppError, runEvent } from "../src/app.ts";
import { parseCredits } from "../src/budget/credits.ts";
import { CreditLedger } from "../src/budget/ledger.ts";
import { parseConfig } from "../src/config.ts";
import type { ProviderAdapter } from "../src/providers/adapter.ts";
import { AdapterError } from "../src/providers/oauth-adapter.ts";
import type { Executor } from "../src/sandbox/executor.ts";
import { FAKE_MODEL, message, responseStream } from "./support/fake-pi.ts";

// Synthetic pages only.
const page = (articles: number, answers: string[]) =>
  `<html><header><div class="user">synthetic</div></header><main>${'<article class="day-desc"><p>Synthetic.</p></article>'.repeat(articles)}${answers.map((a) => `<p>Your puzzle answer was <code>${a}</code>.</p>`).join("")}<form><input type="hidden" name="level" value="${answers.length + 1}"/></form></main></html>`;
const correct = "<html><main><article><p>That's the right answer!</p></article></main></html>";

async function setup(t: test.TestContext, start: string) {
  const root = await mkdtemp(join(tmpdir(), "boc-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = parseConfig({
    version: 1,
    event: { year: 2025 },
    storageDir: join(root, "var"),
    aoc: { sessionCookieFile: join(root, "cookie"), contact: "ops@example.invalid" },
    sandbox: { image: `sha256:${"a".repeat(64)}` },
    creditPools: [
      {
        id: "pool",
        provider: "github-copilot",
        unit: "u",
        limits: { event: "100", perPuzzle: "20" },
      },
    ],
    subscriptions: [
      {
        id: "sub",
        provider: "github-copilot",
        credentialFile: join(root, "cred"),
        model: FAKE_MODEL.id,
        creditPool: "pool",
        limits: { event: "100", perPuzzle: "20" },
        estimate: {
          pricing: "synthetic",
          rates: { input: "1", output: "1", cacheRead: "1", cacheWrite: "1" },
        },
      },
    ],
  });
  let now = Date.parse(start);
  const sleeps: number[] = [];
  const aocCalls: string[] = [];
  const released = new Set<number>();
  const client: AocClient = {
    prepare: async () => {},
    fetchPuzzle: async (_y, day) => {
      aocCalls.push(`puzzle ${day} @${new Date(now).toISOString()}`);
      if (!released.has(day))
        throw new AocError("not-available", "Puzzle not available yet.", 404, true);
      const solved = aocCalls.filter((c) => c === `answer ${day}/1`).length;
      return solved ? page(2, ["1"]) : page(1, []);
    },
    fetchInput: async (_y, day) => {
      aocCalls.push(`input ${day}`);
      return "1\n";
    },
    submitAnswer: async (_y, day, part) => {
      aocCalls.push(`answer ${day}/${part}`);
      return correct;
    },
  };
  const invoke = (_m: unknown, context: TranscriptContext) => {
    const text = JSON.stringify(context.messages.find((m) => m.role === "user")?.content);
    const part = /part 2\./.test(text) ? "2" : "1";
    return responseStream(
      message({
        content: [
          { type: "toolCall", id: "p", name: "propose_answer", arguments: { answer: part } },
        ],
        stopReason: "toolUse",
      }),
    );
  };
  const adapter: ProviderAdapter = {
    model: FAKE_MODEL,
    transport: { stream: invoke, streamSimple: invoke },
    meter: {
      maxCharge: () => parseCredits("1"),
      actualCharge: async () => ({ credits: parseCredits("1"), receipt: "receipt:fake" }),
    },
    minimumAttemptCredits: parseCredits("1"),
  };
  const executor: Executor = {
    run: async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      truncated: false,
      durationMs: 0,
    }),
  };
  const events: string[] = [];
  const run = (extra: Partial<Parameters<typeof runEvent>[0]> = {}) =>
    runEvent({
      config,
      version: "test",
      adapters: { "github-copilot": async () => adapter },
      aocClient: client,
      executor,
      now: () => new Date(now),
      sleep: async (ms, signal) => {
        signal?.throwIfAborted();
        sleeps.push(ms);
        now += ms;
      },
      onEvent: (e) => events.push(e),
      ...extra,
    });
  return { root, config, run, released, aocCalls, sleeps, events };
}

test("without an eligible adapter nothing is opened or contacted", async (t) => {
  const f = await setup(t, "2026-01-01T00:00:00.000Z");
  await assert.rejects(f.run({ adapters: {} }), AppError);
  await assert.rejects(
    runEvent({ config: f.config, version: "test" }),
    /No eligible provider adapter/,
  );
  await assert.rejects(stat(join(f.root, "var")), "no storage, ledger, or journal created");
  assert.deepEqual(f.aocCalls, []);
  await assert.rejects(
    f.run({
      adapters: {
        "github-copilot": async () => ({ model: { ...FAKE_MODEL, id: "other" } }) as never,
      },
    }),
    /does not match/,
  );
});

test("past mode solves released days; an unreleased explicit day is retried boundedly", async (t) => {
  const f = await setup(t, "2026-01-01T00:00:00.000Z");
  f.released.add(1);
  const results = await f.run({ days: [1, 2] });
  assert.deepEqual(results, [
    { puzzle: "day-01", part1: "solved", part2: "solved" },
    { puzzle: "day-02", part1: "not-released", part2: undefined },
  ]);
  assert.deepEqual(f.sleeps, UNLOCK_RETRY_DELAYS_MS, "bounded unlock retries, no polling loop");
  assert.equal(
    f.aocCalls.filter((c) => c.startsWith("puzzle 2")).length,
    UNLOCK_RETRY_DELAYS_MS.length + 1,
  );
  const log = await readFile(join(f.root, "var/runs/2025/events.log"), "utf8");
  assert.match(log, /^\d{4}-\d\d-\d\dT.* day-01 part 1: attempt 1 started \(sub\)$/m);
  assert.equal((await stat(join(f.root, "var/runs/2025/events.log"))).mode & 0o077, 0);
  const summary = await readFile(join(f.root, "var/runs/2025/SUMMARY.md"), "utf8");
  assert.match(summary, /\[events\.log\]\(events\.log\)/);
  assert.match(summary, /day-01.*solved.*solved/);
  assert.match(summary, /## Credits/);

  // Re-running is idempotent: solved days make no AoC requests.
  const before = f.aocCalls.length;
  const again = await f.run({ days: [1] });
  assert.deepEqual(again, [{ puzzle: "day-01", part1: "solved", part2: "solved" }]);
  assert.equal(f.aocCalls.length, before);
});

test("progress snapshots carry the current puzzle and ledger status", async (t) => {
  const f = await setup(t, "2026-01-01T00:00:00.000Z");
  f.released.add(1);
  const seen: string[] = [];
  await f.run({
    days: [1],
    onProgress: (p) =>
      seen.push(
        `${p.current}:${p.state.puzzles["day-01"]?.parts[1].status ?? "-"}:${p.ledger.counters.some((c) => c.period === "day-01")}`,
      ),
  });
  assert.ok(seen.includes("day-01:solving:true"));
  assert.equal(seen.at(-1), "day-01:solved:true");
});

test("live mode sleeps until release before the first request, then stops after the last day", async (t) => {
  const f = await setup(t, "2025-12-01T04:00:00.000Z");
  f.released.add(1);
  const results = await f.run();
  assert.equal(results[0]?.part2, "solved");
  assert.ok(f.aocCalls[0]?.endsWith("@2025-12-01T05:00:03.000Z"), f.aocCalls[0]);
  assert.equal(f.sleeps[0], 1_800_000, "first to the pre-release check, 30 min before");
  assert.equal(
    f.sleeps.slice(0, 31).reduce((a, b) => a + b, 0),
    3_600_000,
    "then on to the release",
  );
  assert.equal(results.at(-1)?.part1, "not-released");
  assert.equal(results.length, 2, "default mode stops at the first unavailable day");
  const dir = join(f.root, "var/ledger/2025");
  const ledger = await CreditLedger.open({ directory: dir, config: f.config });
  t.after(() => ledger.close().catch(() => {}));
  const pool = ledger.status().counters.find((c) => c.scope === "pool" && c.period === "day-01");
  assert.equal(pool?.spent, parseCredits("2"));
});

test("an abort while waiting stops cleanly and leaves resumable state", async (t) => {
  const f = await setup(t, "2025-12-01T04:00:00.000Z");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.run({ signal: controller.signal }));
  assert.deepEqual(f.aocCalls, []);
  f.released.add(1);
  const results = await f.run({ days: [1] });
  assert.equal(results[0]?.part1, "solved", "locks were released; the run resumes");
});

test("subscriptions without an estimate are not used; missing provider caps are warned about", async (t) => {
  const f = await setup(t, "2026-01-01T00:00:00.000Z");
  const events: string[] = [];
  const withoutEstimate = structuredClone(f.config);
  for (const s of withoutEstimate.subscriptions) delete s.estimate;
  await assert.rejects(
    f.run({ config: withoutEstimate, onEvent: (e) => events.push(e) }),
    /No eligible provider adapter/,
  );
  assert.ok(events.some((e) => /sub: no estimate configured/.test(e)));
  f.released.add(1);
  const warned: string[] = [];
  await f.run({ days: [1], onEvent: (e) => warned.push(e) });
  assert.ok(warned.some((e) => /pool pool has no provider-side spending cap/.test(e)));
});

interface FirstBehavior {
  /** Whether the first subscription's next model call is refused (credential). */
  refuses: () => boolean;
  checkCredential?: () => Promise<void>;
}

async function twoSubscriptions(t: test.TestContext, first: FirstBehavior) {
  const root = await mkdtemp(join(tmpdir(), "boc-failover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const estimate = {
    pricing: "synthetic",
    rates: { input: "1", output: "1", cacheRead: "1", cacheWrite: "1" },
  };
  const limits = { event: "100", perPuzzle: "20" };
  const config = parseConfig({
    version: 1,
    event: { year: 2025 },
    storageDir: join(root, "var"),
    aoc: { sessionCookieFile: join(root, "cookie"), contact: "ops@example.invalid" },
    sandbox: { image: `sha256:${"a".repeat(64)}` },
    creditPools: [
      { id: "pool-a", provider: "github-copilot", unit: "a", limits },
      { id: "pool-b", provider: "openai-codex", unit: "b", limits },
    ],
    subscriptions: [
      {
        id: "first",
        provider: "github-copilot",
        credentialFile: join(root, "a"),
        model: FAKE_MODEL.id,
        creditPool: "pool-a",
        limits,
        estimate,
      },
      {
        id: "second",
        provider: "openai-codex",
        credentialFile: join(root, "b"),
        model: FAKE_MODEL.id,
        creditPool: "pool-b",
        limits,
        estimate,
      },
    ],
  });
  const solved = new Map<number, number>();
  const aocCalls: string[] = [];
  let session: () => "ok" | "logged-out" = () => "ok";
  const client: AocClient = {
    prepare: async () => {},
    fetchPuzzle: async (_y, day) => {
      aocCalls.push(`puzzle ${day}`);
      return (solved.get(day) ?? 0) >= 1 ? page(2, ["1"]) : page(1, []);
    },
    fetchInput: async () => "1\n",
    submitAnswer: async (_y, day) => {
      solved.set(day, (solved.get(day) ?? 0) + 1);
      return correct;
    },
    checkSession: async () => {
      aocCalls.push(`session @${new Date(clock).toISOString()}`);
      return session();
    },
  };
  const calls = { first: 0, second: 0 };
  const adapter = (name: "first" | "second"): ProviderAdapter => {
    const invoke = (_m: unknown, context: TranscriptContext) => {
      calls[name]++;
      if (name === "first" && first.refuses()) {
        return responseStream(
          message({
            content: [],
            stopReason: "error",
            errorMessage: "Encountered invalidated oauth token for user, failing request",
          }),
        );
      }
      const text = JSON.stringify(context.messages.find((m) => m.role === "user")?.content);
      const answer = /part 2\./.test(text) ? "2" : "1";
      return responseStream(
        message({
          content: [{ type: "toolCall", id: "p", name: "propose_answer", arguments: { answer } }],
          stopReason: "toolUse",
        }),
      );
    };
    return {
      model: FAKE_MODEL,
      transport: { stream: invoke, streamSimple: invoke },
      meter: {
        maxCharge: () => parseCredits("1"),
        actualCharge: async () => ({ credits: parseCredits("1"), receipt: "receipt:fake" }),
      },
      minimumAttemptCredits: parseCredits("1"),
      ...(name === "first" && first.checkCredential
        ? { checkCredential: first.checkCredential }
        : {}),
    };
  };
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const events: string[] = [];
  const run = (extra: Partial<Parameters<typeof runEvent>[0]> = {}) =>
    runEvent({
      config,
      version: "test",
      days: [1, 2],
      adapters: {
        "github-copilot": async () => adapter("first"),
        "openai-codex": async () => adapter("second"),
      },
      aocClient: client,
      executor: {
        run: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          truncated: false,
          durationMs: 0,
        }),
      },
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      maxAttemptsPerPart: 1,
      onEvent: (e) => events.push(`${new Date(clock).toISOString()} ${e}`),
      ...extra,
    });
  return {
    run,
    calls,
    events,
    aocCalls,
    setClock: (iso: string) => {
      clock = Date.parse(iso);
    },
    setSession: (value: () => "ok" | "logged-out") => {
      session = value;
    },
  };
}

test("a refusing subscription fails over to the next one; the refusal is not an attempt", async (t) => {
  const f = await twoSubscriptions(t, { refuses: () => true });
  const results = await f.run();
  assert.deepEqual(
    results.map((r) => [r.part1, r.part2]),
    [
      ["solved", "solved"],
      ["solved", "solved"],
    ],
    "an attempt cap of 1 still leaves room: refusals are not attempts",
  );
  // Refused once; without a passing credential check it stays unavailable.
  assert.equal(f.calls.first, 1);
  assert.equal(f.calls.second, 4);
  assert.equal(f.events.filter((e) => /failing over to second/.test(e)).length, 1);
  assert.ok(
    f.events.every((e) => !/invalidated oauth token/.test(e)),
    "no raw provider text",
  );
});

test("a failed start check skips the subscription with no model call", async (t) => {
  const f = await twoSubscriptions(t, {
    refuses: () => false,
    checkCredential: async () => {
      throw new AdapterError("Copilot token refresh failed; run boc login if this persists.");
    },
  });
  const results = await f.run();
  assert.ok(results.every((r) => r.part1 === "solved" && r.part2 === "solved"));
  assert.equal(f.calls.first, 0);
  assert.ok(
    f.events.some((e) =>
      /start check FAILED: subscription first: Copilot token refresh failed/.test(e),
    ),
  );
  assert.ok(f.aocCalls[0]?.startsWith("session"), "the AoC session is checked at start");
});

test("a credential refusal repaired by a forced refresh keeps the subscription in use", async (t) => {
  let refusals = 1;
  let checks = 0;
  const f = await twoSubscriptions(t, {
    refuses: () => refusals-- > 0,
    checkCredential: async () => {
      checks++;
    },
  });
  const results = await f.run();
  assert.ok(results.every((r) => r.part1 === "solved" && r.part2 === "solved"));
  assert.equal(checks, 2, "at start, and right after the refusal");
  assert.equal(f.calls.second, 1, "only the refused part failed over");
  assert.equal(f.calls.first, 4, "then the refreshed subscription was used again");
});

test("readiness is checked 30 minutes before a release, and rechecked after a failure", async (t) => {
  let credentialChecks = 0;
  const f = await twoSubscriptions(t, {
    refuses: () => false,
    checkCredential: async () => {
      // Fails at start and at T-30; the operator's boc login fixes it before T-5.
      if (++credentialChecks <= 2) {
        throw new AdapterError("Copilot token refresh failed; run boc login if this persists.");
      }
    },
  });
  f.setClock("2025-12-01T03:00:00.000Z"); // Two hours before day 1.
  let sessionChecks = 0;
  f.setSession(() => (++sessionChecks === 2 ? "logged-out" : "ok"));
  const results = await f.run({ days: [1] });
  assert.equal(results[0]?.part2, "solved");
  const at = (time: string, pattern: RegExp) =>
    assert.ok(
      f.events.some((e) => e.startsWith(time) && pattern.test(e)),
      `${time} ${pattern}`,
    );
  at("2025-12-01T04:30:00.000Z", /day-01 pre-release check FAILED: subscription first/);
  at("2025-12-01T04:30:00.000Z", /day-01 pre-release check FAILED: the AoC session/);
  at(
    "2025-12-01T04:55:00.000Z",
    /day-01 final pre-release check: subscription first is usable again/,
  );
  at("2025-12-01T04:55:00.000Z", /day-01 final pre-release check passed/);
  assert.deepEqual(
    f.aocCalls.filter((c) => c.startsWith("session")),
    [
      "session @2025-12-01T03:00:00.000Z",
      "session @2025-12-01T04:30:00.000Z",
      "session @2025-12-01T04:55:00.000Z",
    ],
    "one light read at start, at T-30, and one recheck at T-5",
  );
  assert.equal(f.calls.second, 0, "the repaired first subscription solved the day");
  assert.equal(f.calls.first, 2);
});
