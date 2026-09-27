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
import type { Executor } from "../src/sandbox/executor.ts";
import { FAKE_MODEL, message, responseStream } from "./support/fake-pi.ts";

// Synthetic pages only.
const page = (articles: number, answers: string[]) =>
  `<html><header><div class="user">synthetic</div></header><main>${'<article class="day-desc"><p>Synthetic.</p></article>'.repeat(articles)}${answers.map((a) => `<p>Your puzzle answer was <code>${a}</code>.</p>`).join("")}</main></html>`;
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
  const summary = await readFile(join(f.root, "var/runs/2025/SUMMARY.md"), "utf8");
  assert.match(summary, /day-01.*solved.*solved/);
  assert.match(summary, /## Credits/);

  // Re-running is idempotent: solved days make no AoC requests.
  const before = f.aocCalls.length;
  const again = await f.run({ days: [1] });
  assert.deepEqual(again, [{ puzzle: "day-01", part1: "solved", part2: "solved" }]);
  assert.equal(f.aocCalls.length, before);
});

test("live mode sleeps until release before the first request, then stops after the last day", async (t) => {
  const f = await setup(t, "2025-12-01T04:00:00.000Z");
  f.released.add(1);
  const results = await f.run();
  assert.equal(results[0]?.part2, "solved");
  assert.ok(f.aocCalls[0]?.endsWith("@2025-12-01T05:00:03.000Z"), f.aocCalls[0]);
  assert.equal(
    f.sleeps.slice(0, 60).reduce((a, b) => a + b, 0),
    3_600_000,
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
