import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { Alert, Notifier } from "../src/alerts/notifier.ts";
import { UNLOCK_RETRY_DELAYS_MS } from "../src/aoc/calendar.ts";
import { type AocClient, AocError } from "../src/aoc/client.ts";
import { AppError, runEvent } from "../src/app.ts";
import { parseCredits } from "../src/budget/credits.ts";
import { CreditLedger } from "../src/budget/ledger.ts";
import { parseConfig } from "../src/config.ts";
import type { ProviderAdapter } from "../src/providers/adapter.ts";
import { AdapterError } from "../src/providers/oauth-adapter.ts";
import type { Executor } from "../src/sandbox/executor.ts";
import { LOCK_FILE } from "../src/state/journal.ts";
import { layout } from "../src/state/layout.ts";
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
  const sum = (n: number) => f.sleeps.slice(0, n).reduce((a, b) => a + b, 0);
  assert.ok(
    f.sleeps.slice(0, 61).every((ms) => ms <= 60_000),
    "wall-clock steps of at most 60 s until the release",
  );
  assert.equal(sum(30), 1_800_000, "first to the pre-release check, 30 min before");
  assert.equal(sum(61), 3_603_000, "then on to the release plus its margin");
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
  /** Whether a subscription's next model call fails with a connection error. */
  outage?: (name: "first" | "second") => boolean;
  /** Per-puzzle credit limit of the first subscription (default 20). */
  firstPerPuzzle?: string;
  /** Tool calls the first subscription makes before proposing (default 0). */
  firstTurns?: number;
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
        limits: { ...limits, perPuzzle: first.firstPerPuzzle ?? limits.perPuzzle },
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
      if (first.outage?.(name)) {
        return responseStream(
          message({ content: [], stopReason: "error", errorMessage: "Connection error." }),
        );
      }
      const turns = context.messages.filter((m) => m.role === "assistant").length;
      if (name === "first" && turns < (first.firstTurns ?? 0)) {
        return responseStream(
          message({
            content: [{ type: "toolCall", id: `l${turns}`, name: "list_files", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
      }
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
        // Like the real adapters: a call that failed before any output costs nothing.
        actualCharge: async (m: { stopReason: string }) => ({
          credits: parseCredits(m.stopReason === "error" ? "0" : "1"),
          receipt: "receipt:fake",
        }),
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
    config,
    now: () => clock,
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
      throw new AdapterError("Copilot rejected the credential; run boc login.", "rejected");
    },
  });
  const results = await f.run();
  assert.ok(results.every((r) => r.part1 === "solved" && r.part2 === "solved"));
  assert.equal(f.calls.first, 0);
  assert.ok(
    f.events.some((e) =>
      /start check FAILED: subscription first: Copilot rejected the credential/.test(e),
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
        throw new AdapterError("Copilot rejected the credential; run boc login.", "rejected");
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

function recordingNotifier() {
  const alerts: Alert[] = [];
  const heartbeats: boolean[] = [];
  const notifier: Notifier = {
    notify: (a) => alerts.push(a),
    heartbeat: (ok) => heartbeats.push(ok),
    flush: async () => {},
  };
  return { alerts, heartbeats, notifier };
}

test("the run alerts on failed checks, failover, and each finished day", async (t) => {
  const f = await twoSubscriptions(t, {
    refuses: () => false,
    checkCredential: async () => {
      throw new AdapterError("Copilot rejected the credential; run boc login.", "rejected");
    },
  });
  const r = recordingNotifier();
  await f.run({ notifier: r.notifier });
  assert.deepEqual(r.heartbeats, [false], "the start check failed");
  const [check, started, day1, day2] = r.alerts;
  assert.equal(check?.priority, "urgent");
  assert.equal(check?.title, "BoC 2025: start check failed");
  assert.match(
    check?.message ?? "",
    /Subscription first: credential rejected; run boc login\.\nStill usable: second\./,
  );
  assert.equal(started?.title, "BoC 2025: started");
  assert.equal(day1?.title, "BoC 2025: day-01 solved");
  assert.equal(day1?.priority, "default");
  assert.match(
    day1?.message ?? "",
    /^part 1: solved, 1 attempt\(s\), 1 submission\(s\); part 2: solved, 1 attempt\(s\), 1 submission\(s\)\. Credits: second 2 b\.$/,
  );
  assert.equal(day2?.title, "BoC 2025: day-02 solved");
  assert.equal(r.alerts.length, 4);
});

test("a refusal alerts as a failover; a preflight error alerts as a stop", async (t) => {
  const f = await twoSubscriptions(t, { refuses: () => true });
  const r = recordingNotifier();
  await f.run({ notifier: r.notifier, days: [1] });
  const failover = r.alerts.find((a) => /failover/.test(a.title));
  assert.equal(failover?.priority, "high");
  assert.match(
    failover?.message ?? "",
    /subscription first unavailable \(credential rejected; run boc login\); failing over to second/,
  );
  const s = recordingNotifier();
  await assert.rejects(f.run({ notifier: s.notifier, adapters: {} }), AppError);
  assert.equal(s.alerts.at(-1)?.priority, "urgent");
  assert.equal(s.alerts.at(-1)?.title, "BoC 2025: stopped with an error");
  assert.match(s.alerts.at(-1)?.message ?? "", /No eligible provider adapter/);
  assert.deepEqual(s.heartbeats, [false]);
});

test("an outage fails over without counting an attempt, then backs off", async (t) => {
  const f = await twoSubscriptions(t, {
    refuses: () => false,
    outage: (name) => name === "first",
  });
  const results = await f.run({ days: [1] });
  assert.deepEqual(
    results.map((r) => [r.part1, r.part2]),
    [["solved", "solved"]],
    "an attempt cap of 1 still leaves room: an outage is not an attempt",
  );
  assert.equal(f.calls.first, 1, "the backoff keeps the failed subscription out");
  assert.ok(
    f.events.some((e) =>
      /subscription first unavailable \(network or server error; retrying in 15 s\); failing over to second/.test(
        e,
      ),
    ),
  );
  assert.ok(
    f.events.every((e) => !/Connection error/.test(e)),
    "no raw provider text",
  );
});

test("when every subscription is out, the part waits with backoff and then solves", async (t) => {
  let failures = 4; // Two outages on each subscription, then recovery.
  const f = await twoSubscriptions(t, {
    refuses: () => false,
    outage: () => failures-- > 0,
  });
  const r = recordingNotifier();
  const start = f.now();
  const results = await f.run({ days: [1], notifier: r.notifier });
  assert.deepEqual(
    results.map((x) => [x.part1, x.part2]),
    [["solved", "solved"]],
  );
  const waits = f.events.filter((e) => /no subscription is usable now; retrying at/.test(e));
  assert.equal(waits.length, 2);
  assert.ok(
    f.events.some((e) => /retrying in 30 s/.test(e)),
    "the backoff grows",
  );
  assert.ok(f.now() - start >= 30_000);
  assert.equal(
    r.alerts.filter((a) => /waiting for providers/.test(a.title)).length,
    1,
    "one alert per part",
  );
});

test("a persistent outage is retried until 6 hours after release, then the run moves on", async (t) => {
  const f = await twoSubscriptions(t, { refuses: () => false, outage: () => true });
  f.setClock("2025-12-01T04:00:00.000Z");
  const r = recordingNotifier();
  const results = await f.run({ days: [1, 2], notifier: r.notifier });
  assert.deepEqual(
    results.map((x) => [x.part1, x.part2]),
    [
      ["provider-unavailable", undefined],
      ["provider-unavailable", undefined],
    ],
    "the run continued with day 2",
  );
  const giveUp = f.events.find((e) => /day-01: provider retry window ends/.test(e)) ?? "";
  assert.ok(giveUp >= "2025-12-01T10:55:00.000Z" && giveUp <= "2025-12-01T11:00:00.000Z", giveUp);
  assert.ok(f.calls.first + f.calls.second < 400, "retries are bounded by the backoff");
  assert.ok(r.alerts.some((a) => a.title === "BoC 2025: day-01 abandoned"));
});

test("an unreachable start check is retried soon instead of skipping the day", async (t) => {
  let checks = 0;
  const f = await twoSubscriptions(t, {
    refuses: () => false,
    checkCredential: async () => {
      if (++checks === 1) throw new AdapterError("Copilot could not be reached.", "unreachable");
    },
  });
  f.setClock("2025-12-01T04:58:00.000Z"); // After the pre-release checks.
  const results = await f.run({ days: [1] });
  assert.equal(results[0]?.part2, "solved");
  assert.ok(
    f.events.some((e) => /start check FAILED: subscription first: .*Retrying in 1 min/.test(e)),
  );
  assert.equal(f.calls.second, 0, "the first subscription was usable again at release");
  assert.equal(f.calls.first, 2);
});

test("credits running out mid-attempt fail over to another subscription", async (t) => {
  const f = await twoSubscriptions(t, {
    refuses: () => false,
    firstPerPuzzle: "1",
    firstTurns: 1,
  });
  const results = await f.run({ days: [1], maxAttemptsPerPart: 2 });
  assert.deepEqual(
    results.map((x) => [x.part1, x.part2]),
    [["solved", "solved"]],
  );
  assert.ok(f.events.some((e) => /attempt 1 stopped: credits exhausted on first/.test(e)));
  assert.ok(f.events.some((e) => /day-01 part 1: attempt 2 started \(second\)/.test(e)));
});

test("a stale lock from a dead process or an earlier boot is removed at start", async (t) => {
  const f = await twoSubscriptions(t, { refuses: () => false });
  const paths = layout(f.config.storageDir, 2025);
  await f.run({ days: [1] }); // Creates the journals.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const boot = Math.round(Date.now() / 1000 - uptime());
  const lock = (pid: number, bootTime: number) =>
    `${JSON.stringify({ pid, host: hostname(), boot: bootTime, at: new Date().toISOString() })}\n`;
  await writeFile(join(paths.ledger, LOCK_FILE), lock(dead, boot), { mode: 0o600 });
  await writeFile(join(paths.runs, LOCK_FILE), lock(process.pid, boot - 3600), { mode: 0o600 });
  await f.run({ days: [2] });
  assert.equal(f.events.filter((e) => /removed a stale (ledger|run-state) lock/.test(e)).length, 2);
  // A lock whose owner runs (this process, same boot) is kept and explained.
  await writeFile(join(paths.ledger, LOCK_FILE), lock(process.pid, boot), { mode: 0o600 });
  await assert.rejects(
    f.run({ days: [2] }),
    /Locked by another process \(PID \d+\)\. If no BoC process is running, run boc ledger break-lock/,
  );
});

test("a wait of months before the event sleeps in short steps, never past the release", async (t) => {
  // Regression (2026-09-29, on the Pi): one timer for ~62 days fired after 1 ms.
  const f = await setup(t, "2025-09-29T20:50:00.000Z");
  f.released.add(1);
  const results = await f.run({ days: [1] });
  assert.equal(results[0]?.part2, "solved");
  assert.ok(f.sleeps.length > 80_000 && f.sleeps.every((ms) => ms <= 60_000));
  assert.ok(f.aocCalls[0]?.endsWith("@2025-12-01T05:00:03.000Z"), f.aocCalls[0]);
});
