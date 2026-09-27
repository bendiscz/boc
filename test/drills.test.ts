import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { type AocClient, AocError } from "../src/aoc/client.ts";
import { runEvent } from "../src/app.ts";
import { parseCredits } from "../src/budget/credits.ts";
import { CreditLedger } from "../src/budget/ledger.ts";
import { parseConfig } from "../src/config.ts";
import type { ProviderAdapter } from "../src/providers/adapter.ts";
import type { Executor } from "../src/sandbox/executor.ts";
import { RunStore } from "../src/state/run-state.ts";
import { FAKE_MODEL, message, responseStream } from "./support/fake-pi.ts";

// Outage and recovery drills with synthetic pages and fake transports only.
const page = (articles: number, answers: string[]) =>
  `<html><header><div class="user">synthetic</div></header><main>${'<article class="day-desc"><p>Synthetic.</p></article>'.repeat(articles)}${answers.map((a) => `<p>Your puzzle answer was <code>${a}</code>.</p>`).join("")}${answers.length < articles || articles === 1 ? `<form><input type="hidden" name="level" value="${answers.length + 1}"/></form>` : ""}</main></html>`;
const correct = "<html><main><article><p>That's the right answer!</p></article></main></html>";

interface Faults {
  submit?: AocError[];
  puzzle?: AocError[];
}

async function drill(t: test.TestContext, subscriptions = 1, perPuzzle = "20") {
  const root = await mkdtemp(join(tmpdir(), "boc-drill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const subs = Array.from({ length: subscriptions }, (_, i) => ({
    id: `sub-${i + 1}`,
    provider: "github-copilot" as const,
    credentialFile: join(root, `cred-${i}`),
    model: FAKE_MODEL.id,
    creditPool: `pool-${i + 1}`,
    limits: { event: "100", perPuzzle },
    estimate: {
      pricing: "synthetic",
      rates: { input: "1", output: "1", cacheRead: "1", cacheWrite: "1" },
    },
  }));
  const config = parseConfig({
    version: 1,
    event: { year: 2025 },
    storageDir: join(root, "var"),
    aoc: { sessionCookieFile: join(root, "cookie"), contact: "ops@example.invalid" },
    sandbox: { image: `sha256:${"a".repeat(64)}` },
    creditPools: subs.map((s) => ({
      id: s.creditPool,
      provider: "github-copilot",
      unit: "u",
      limits: { event: "100", perPuzzle },
    })),
    subscriptions: subs,
  });
  const faults: Faults = {};
  const accepted: string[] = [];
  const calls: string[] = [];
  const client: AocClient = {
    prepare: async () => {},
    fetchPuzzle: async () => {
      calls.push("puzzle");
      const fault = faults.puzzle?.shift();
      if (fault) throw fault;
      return page(accepted.length ? 2 : 1, accepted);
    },
    fetchInput: async () => {
      calls.push("input");
      return "1\n";
    },
    submitAnswer: async (_y, _d, part, answer) => {
      calls.push(`answer ${part}=${answer}`);
      const fault = faults.submit?.shift();
      if (fault) {
        // The server received it before the connection failed.
        accepted.push(answer);
        throw fault;
      }
      accepted.push(answer);
      return correct;
    },
  };
  const models: string[] = [];
  const adapter = (subscription: string): ProviderAdapter => {
    const invoke = (_m: unknown, context: TranscriptContext) => {
      models.push(subscription);
      const text = JSON.stringify(context.messages.find((m) => m.role === "user")?.content);
      const answer = /part 2\./.test(text) ? "22" : "11";
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
    };
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
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const run = () =>
    runEvent({
      config,
      version: "test",
      days: [1],
      adapters: { "github-copilot": async (s) => adapter(s.id) },
      aocClient: client,
      executor,
      now: () => new Date(now),
      sleep: async (ms) => {
        now += ms;
      },
    });
  const inspect = () =>
    RunStore.inspect({ directory: join(root, "var/runs/2025"), eventYear: 2025 });
  return { config, root, faults, calls, models, run, inspect };
}

test("an AoC outage during submission is reconciled from the page, never resubmitted", async (t) => {
  const d = await drill(t);
  d.faults.submit = [new AocError("network", "AoC request failed.", undefined, true)];
  const first = await d.run();
  assert.equal(first[0]?.part1, "solved", "same run: the uncertain part is reconciled by reading");
  assert.equal(d.calls.filter((c) => c === "answer 1=11").length, 1, "never submitted twice");
  assert.equal(first[0]?.part2, "solved");
});

test("an outage on reconciliation leaves the part uncertain until a later run", async (t) => {
  const d = await drill(t);
  d.faults.submit = [new AocError("timeout", "AoC request timed out.", undefined, true)];
  d.faults.puzzle = [];
  // First fetch succeeds; the reconciliation fetch fails with an outage.
  const original = d.faults;
  const outage = new AocError("http", "Unexpected AoC HTTP status.", 503, true);
  let fetches = 0;
  Object.defineProperty(original, "puzzle", {
    get: () => (++fetches === 2 ? [outage] : []),
  });
  await assert.rejects(d.run(), (e) => e instanceof AocError && e.status === 503);
  assert.equal((await d.inspect()).puzzles["day-01"]?.parts[1].status, "uncertain");
  const second = await d.run();
  assert.equal(second[0]?.part1, "solved");
  assert.equal(d.calls.filter((c) => c.startsWith("answer 1=")).length, 1);
});

test("an expired session stops the run with a clear error and resumes after renewal", async (t) => {
  const d = await drill(t);
  d.faults.puzzle = [new AocError("auth", "AoC rejected the session.", 400, true)];
  await assert.rejects(d.run(), /rejected the session/);
  assert.deepEqual(d.models, [], "no model call without the puzzle");
  const resumed = await d.run();
  assert.deepEqual(resumed, [{ puzzle: "day-01", part1: "solved", part2: "solved" }]);
});

test("quota exhaustion on one subscription falls over to the next without exceeding limits", async (t) => {
  const d = await drill(t, 2, "1");
  const result = await d.run();
  assert.deepEqual(result, [{ puzzle: "day-01", part1: "solved", part2: "solved" }]);
  assert.deepEqual(d.models, ["sub-1", "sub-2"], "part 2 ran on the second subscription");
  const ledger = await CreditLedger.inspect({
    directory: join(d.root, "var/ledger/2025"),
    config: d.config,
  });
  for (const c of ledger.counters)
    assert.equal(c.exceeded, false, `${c.scope}/${c.id}/${c.period}`);
  const part2 = (await d.inspect()).puzzles["day-01"]?.parts[2];
  assert.equal(part2?.lastSubscription, "sub-2");
});

test("a process killed mid-attempt resumes with a new attempt and no duplicate state", async (t) => {
  const d = await drill(t);
  // Simulate a crash: an attempt was started, then the process died without closing.
  const runs = join(d.root, "var/runs/2025");
  const store = await RunStore.open({ directory: runs, eventYear: 2025 });
  const { layout, writeFileAtomic } = await import("../src/state/layout.ts");
  const { createHash } = await import("node:crypto");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const paths = layout(join(d.root, "var"), 2025);
  await writeFileAtomic(paths.input("day-01" as never), "1\n");
  await writeFileAtomic(paths.statement("day-01" as never, 1), page(1, []));
  await store.record({ type: "input-fetched", puzzle: "day-01" as never, sha256: sha("1\n") });
  await store.record({
    type: "statement-fetched",
    puzzle: "day-01" as never,
    part: 1,
    sha256: sha(page(1, [])),
  });
  await store.record({
    type: "attempt-started",
    puzzle: "day-01" as never,
    part: 1,
    attempt: 1,
    subscription: "sub-1",
  });
  await rm(join(runs, "journal.lock")); // the dead process's lock, removed by the operator
  const result = await d.run();
  assert.equal(result[0]?.part1, "solved");
  const part1 = (await d.inspect()).puzzles["day-01"]?.parts[1];
  assert.equal(part1?.attempts, 2, "attempt 1 recorded as interrupted, attempt 2 solved it");
  assert.equal(part1?.submissions.length, 1);
  assert.ok(!d.calls.includes("input"), "the cached input was reused");
});
