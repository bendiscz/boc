import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type AocClient, AocError, type SessionCheck } from "../src/aoc/client.ts";
import { COOKIE_POLL_MS, resilientAocClient } from "../src/aoc/resilient.ts";

async function setup(
  t: test.TestContext,
  script: { puzzle: (AocError | string)[]; session?: SessionCheck[]; deadlineMs?: number },
) {
  const root = await mkdtemp(join(tmpdir(), "boc-resilient-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cookieFile = join(root, "cookie");
  await writeFile(cookieFile, "a".repeat(32));
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const log: string[] = [];
  const calls: string[] = [];
  const hooks: { onSleep?: () => Promise<void> } = {};
  let alerts = 0;
  const raw: AocClient = {
    prepare: async () => {},
    fetchPuzzle: async () => {
      calls.push("puzzle");
      const next = script.puzzle.shift();
      if (next === undefined) throw new Error("script exhausted");
      if (next instanceof AocError) throw next;
      return next;
    },
    fetchInput: async () => "1\n",
    submitAnswer: async () => {
      calls.push("answer");
      throw new AocError("http", "Unexpected AoC HTTP status.", 503, true);
    },
    checkSession: async () => {
      calls.push("session");
      return script.session?.shift() ?? "unknown";
    },
  };
  const client = resilientAocClient({
    client: raw,
    cookieFile,
    deadline: () => 1_000_000 + (script.deadlineMs ?? 6 * 3_600_000),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      await hooks.onSleep?.();
    },
    log: (m) => log.push(m),
    onSessionRejected: () => alerts++,
  });
  return { client, cookieFile, sleeps, log, calls, hooks, alerts: () => alerts };
}

const e500 = () => new AocError("http", "Unexpected AoC HTTP status.", 500, true);
const e503 = () => new AocError("http", "Unexpected AoC HTTP status.", 503, true);

test("transient AoC failures on page reads are retried with the unlock backoff", async (t) => {
  const f = await setup(t, {
    puzzle: [e500(), e503(), new AocError("network", "AoC request failed.", undefined, true), "ok"],
    session: ["unknown"],
  });
  assert.equal(await f.client.fetchPuzzle(2024, 1), "ok");
  assert.deepEqual(f.sleeps, [15_000, 30_000, 60_000]);
  assert.deepEqual(
    f.calls,
    ["puzzle", "session", "puzzle", "puzzle", "puzzle"],
    "one session check",
  );
  assert.ok(f.log.some((m) => /puzzle page failed \(HTTP 503\); retrying in 30 s/.test(m)));
});

test("a rejected session waits for a replaced cookie file, then continues", async (t) => {
  const f = await setup(t, { puzzle: [e500(), "ok"], session: ["logged-out", "ok"] });
  let polls = 0;
  f.hooks.onSleep = async () => {
    if (++polls === 3) {
      await writeFile(f.cookieFile, "b".repeat(32));
      await utimes(f.cookieFile, new Date(), new Date(Date.now() + 5_000));
    }
  };
  assert.equal(await f.client.fetchPuzzle(2024, 1), "ok");
  assert.deepEqual(f.sleeps, [COOKIE_POLL_MS, COOKIE_POLL_MS, COOKIE_POLL_MS]);
  assert.deepEqual(
    f.calls,
    ["puzzle", "session", "session", "puzzle"],
    "no requests while waiting",
  );
  assert.equal(f.alerts(), 1);
  assert.ok(f.log.some((m) => /AoC session accepted again/.test(m)));
});

test("a rejected session is rechecked every 15 minutes without a new cookie", async (t) => {
  const f = await setup(t, { puzzle: [e500(), "ok"], session: ["logged-out", "logged-out", "ok"] });
  assert.equal(await f.client.fetchPuzzle(2024, 1), "ok");
  assert.equal(f.sleeps.length, 30, "two 15-minute rechecks");
  assert.deepEqual(f.calls, ["puzzle", "session", "session", "session", "puzzle"]);
});

test("failures past the deadline are thrown, and answers are never retried", async (t) => {
  const f = await setup(t, { puzzle: [e503(), e503(), e503()], deadlineMs: 60_000 });
  await assert.rejects(
    f.client.fetchPuzzle(2024, 1),
    (e) => e instanceof AocError && e.status === 503,
  );
  assert.deepEqual(f.sleeps, [15_000, 30_000]);
  await assert.rejects(f.client.submitAnswer(2024, 1, 1, "1"), AocError);
  assert.equal(f.calls.filter((c) => c === "answer").length, 1);
  const g = await setup(t, {
    puzzle: [new AocError("auth", "AoC rejected the session.", 400, true)],
    deadlineMs: 0,
  });
  await assert.rejects(g.client.fetchPuzzle(2024, 1), /rejected the session/);
});
