import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attemptKey, isAnswer, puzzleId } from "../src/state/ids.ts";
import { JournalError } from "../src/state/journal.ts";
import { layout, writeFileAtomic } from "../src/state/layout.ts";
import { type RunEvent, RunStore, StateError } from "../src/state/run-state.ts";
import { renderEventSummary, writeViews } from "../src/state/summary.ts";

const day = puzzleId(1);
const hash = (c: string) => c.repeat(64);

async function root(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "boc-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function clock(start = "2025-12-01T05:00:00.000Z") {
  let now = Date.parse(start);
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function openStore(t: test.TestContext, directory: string, now = clock().now) {
  const store = await RunStore.open({ directory, eventYear: 2025, now });
  t.after(() => store.close().catch(() => {}));
  return store;
}

const part1 = { puzzle: day, part: 1 } as const;
const part2 = { puzzle: day, part: 2 } as const;
const invalid = (e: unknown) => e instanceof StateError;

type Where = { readonly puzzle: typeof day; readonly part: 1 | 2 };

async function toProposed(store: RunStore, answer = "42", where: Where = part1, attempt = 1) {
  if (attempt === 1 && where.part === 1) {
    await store.record({ type: "input-fetched", puzzle: day, sha256: hash("a") });
  }
  if (attempt === 1) await store.record({ type: "statement-fetched", ...where, sha256: hash("b") });
  await store.record({ type: "attempt-started", ...where, attempt, subscription: "sub" });
  await store.record({ type: "attempt-finished", ...where, attempt, outcome: "answer", answer });
}

const submit = (
  submission: number,
  attempt: number,
  answer: string,
  where: Where = part1,
): RunEvent => ({
  type: "submission-started",
  ...where,
  submission,
  attempt,
  answer,
});

test("identifiers are canonical and bounded", () => {
  assert.equal(attemptKey(day, 2, 3), "day-01/part-2/attempt-003");
  assert.throws(() => puzzleId(0));
  assert.throws(() => puzzleId(32));
  assert.throws(() => attemptKey(day, 3 as never, 1));
  assert.throws(() => attemptKey(day, 1, 1000));
  assert.equal(isAnswer("12,3"), true);
  assert.equal(isAnswer("with space"), false);
  assert.equal(isAnswer("x\n"), false);
});

test("a two-part puzzle progresses through the full lifecycle", async (t) => {
  const store = await openStore(t, join(await root(t), "runs"));
  await toProposed(store, "42");
  await store.record(submit(1, 1, "42"));
  assert.equal(store.state.puzzles[day]?.parts[1].status, "submitting");
  await store.record({ type: "submission-finished", ...part1, submission: 1, verdict: "correct" });
  assert.equal(store.state.puzzles[day]?.parts[1].status, "solved");
  assert.equal(store.state.puzzles[day]?.parts[1].solvedAnswer, "42");
  await toProposed(store, "99", part2);
  await store.record(submit(1, 1, "99", part2));
  await store.record({ type: "submission-finished", ...part2, submission: 1, verdict: "correct" });
  assert.equal(store.state.puzzles[day]?.parts[2].status, "solved");
});

test("forbidden transitions write nothing", async (t) => {
  const dir = join(await root(t), "runs");
  const store = await openStore(t, dir);
  const before = await readFile(join(dir, "journal.jsonl"), "utf8");
  await assert.rejects(
    store.record({ type: "statement-fetched", ...part2, sha256: hash("c") }),
    invalid,
  );
  await store.record({ type: "statement-fetched", ...part1, sha256: hash("b") });
  await assert.rejects(
    store.record({ type: "attempt-started", ...part1, attempt: 1, subscription: "sub" }),
    invalid,
    "input required",
  );
  await store.record({ type: "input-fetched", puzzle: day, sha256: hash("a") });
  await assert.rejects(
    store.record({ type: "input-fetched", puzzle: day, sha256: hash("f") }),
    invalid,
  );
  await assert.rejects(
    store.record({ type: "attempt-started", ...part1, attempt: 2, subscription: "sub" }),
    invalid,
  );
  await assert.rejects(store.record(submit(1, 1, "42")), invalid, "nothing proposed");
  await assert.rejects(
    store.record({ type: "attempt-finished", ...part1, attempt: 1, outcome: "answer" }),
    invalid,
  );
  await assert.rejects(
    store.record({ type: "input-fetched", puzzle: "day-1", sha256: hash("a") } as never),
    invalid,
  );
  const after = await readFile(join(dir, "journal.jsonl"), "utf8");
  assert.equal(after.split("\n").length - before.split("\n").length, 2);
});

test("judged answers are never resubmitted and bounds constrain integer guesses", async (t) => {
  const time = clock();
  const store = await openStore(t, join(await root(t), "runs"), time.now);
  await toProposed(store, "100");
  await assert.rejects(store.record(submit(1, 1, "101")), invalid, "must equal proposal");
  await store.record(submit(1, 1, "100"));
  await store.record({
    type: "submission-finished",
    ...part1,
    submission: 1,
    verdict: "too-high",
    retryAfter: "2025-12-01T05:01:00.000Z",
  });
  const propose = async (attempt: number, answer: string) => {
    await store.record({ type: "attempt-started", ...part1, attempt, subscription: "s" });
    await store.record({ type: "attempt-finished", ...part1, attempt, outcome: "answer", answer });
  };
  await propose(2, "100");
  await assert.rejects(store.record(submit(2, 2, "100")), /duplicate-answer/);
  await store.record({ type: "proposal-discarded", ...part1, reason: "duplicate-answer" });
  await propose(3, "150");
  await assert.rejects(store.record(submit(2, 3, "150")), /contradicts-too-high/);
  await store.record({ type: "proposal-discarded", ...part1, reason: "contradicts-too-high" });
  await propose(4, "99");
  await assert.rejects(store.record(submit(2, 4, "99")), /cooldown/);
  time.advance(60_000);
  await store.record(submit(2, 4, "99"));
  assert.equal(store.state.puzzles[day]?.parts[1].status, "submitting");
});

test("cooldown embargo is enforced and a cooldown verdict allows the same answer later", async (t) => {
  const time = clock();
  const store = await openStore(t, join(await root(t), "runs"), time.now);
  await toProposed(store, "7");
  await store.record(submit(1, 1, "7"));
  await store.record({
    type: "submission-finished",
    ...part1,
    submission: 1,
    verdict: "cooldown",
    retryAfter: "2025-12-01T05:00:30.000Z",
  });
  assert.equal(store.state.puzzles[day]?.parts[1].status, "proposed");
  await assert.rejects(store.record(submit(2, 1, "7")), /cooldown/);
  time.advance(30_000);
  await store.record(submit(2, 1, "7"));
  await store.record({ type: "submission-finished", ...part1, submission: 2, verdict: "too-low" });
  await store.record({ type: "attempt-started", ...part1, attempt: 2, subscription: "s" });
  await store.record({
    type: "attempt-finished",
    ...part1,
    attempt: 2,
    outcome: "answer",
    answer: "5",
  });
  await assert.rejects(store.record(submit(3, 2, "5")), /contradicts-too-low/);
});

test("restart records interrupted work; an interrupted submission is never retried", async (t) => {
  const dir = join(await root(t), "runs");
  let store = await openStore(t, dir);
  await toProposed(store, "42");
  await store.record({ type: "statement-fetched", ...part1, sha256: hash("b") });
  await store.record(submit(1, 1, "42"));
  // Crash: no close. Simulate a new process by breaking the dead lock.
  await rm(join(dir, "journal.lock"));
  store = await openStore(t, dir);
  const p = store.state.puzzles[day]?.parts[1];
  assert.equal(p?.status, "uncertain");
  assert.equal(p?.submissions[0]?.verdict, "uncertain");
  await assert.rejects(store.record(submit(2, 1, "42")), invalid);
  await store.record({
    type: "submission-reconciled",
    ...part1,
    submission: 1,
    verdict: "not-correct",
    evidence: "puzzle-page-unsolved",
  });
  assert.equal(store.state.puzzles[day]?.parts[1].status, "ready");
  await store.record({ type: "attempt-started", ...part1, attempt: 2, subscription: "s" });
  await store.close();
  store = await openStore(t, dir);
  assert.equal(store.state.puzzles[day]?.parts[1].status, "ready", "interrupted attempt");
  await store.record({ type: "attempt-started", ...part1, attempt: 3, subscription: "s" });
  await store.record({
    type: "attempt-finished",
    ...part1,
    attempt: 3,
    outcome: "answer",
    answer: "42",
  });
  await assert.rejects(store.record(submit(2, 3, "42")), /duplicate-answer/);
});

test("replay rejects inconsistent journals and a different event", async (t) => {
  const dir = join(await root(t), "runs");
  const store = await openStore(t, dir);
  await store.record({ type: "input-fetched", puzzle: day, sha256: hash("a") });
  await store.close();
  const journal = join(dir, "journal.jsonl");
  const lines = (await readFile(journal, "utf8")).trimEnd().split("\n");
  await writeFile(
    journal,
    `${[...lines, JSON.stringify({ seq: lines.length + 1, at: "2025-12-01T05:00:00.000Z", type: "attempt-started", puzzle: day, part: 1, attempt: 1, subscription: "s" })].join("\n")}\n`,
  );
  // Statement never fetched: the part is locked, so the journal is impossible.
  await assert.rejects(
    RunStore.open({ directory: dir, eventYear: 2025 }),
    (e) => e instanceof JournalError && e.code === "corrupt",
  );
  await writeFile(journal, `${lines.join("\n")}\n`);
  await assert.rejects(RunStore.open({ directory: dir, eventYear: 2024 }), StateError);
  await (await RunStore.open({ directory: dir, eventYear: 2025 })).close();
});

test("layout, atomic writes, and derived views are private and navigable", async (t) => {
  const storage = await root(t);
  const paths = layout(storage, 2025);
  assert.equal(paths.attempt(day, 1, 2), join(storage, "puzzles/2025/day-01/part-1/attempt-002"));
  assert.equal(paths.statement(day, 2), join(storage, "puzzles/2025/day-01/part-2.html"));
  assert.throws(() => paths.puzzle("../x" as never));

  const store = await openStore(t, paths.runs);
  await toProposed(store, "a|b");
  await store.record(submit(1, 1, "a|b"));
  await store.record({
    type: "submission-finished",
    ...part1,
    submission: 1,
    verdict: "incorrect",
  });
  await writeViews(paths, store.state);
  const summary = await readFile(paths.summary, "utf8");
  assert.match(summary, /\[day-01\]\(\.\.\/\.\.\/puzzles\/2025\/day-01\/README\.md\)/);
  const readme = await readFile(paths.puzzleReadme(day), "utf8");
  assert.match(readme, /a\\\|b \| incorrect/);
  assert.match(readme, /\[attempt-001\]\(part-1\/attempt-001\/\)/);
  assert.match(await readFile(paths.index, "utf8"), /\[2025\]\(runs\/2025\/SUMMARY\.md\)/);
  for (const file of [paths.summary, paths.index, paths.puzzleReadme(day)]) {
    assert.equal((await stat(file)).mode & 0o077, 0);
  }
  await writeFileAtomic(paths.summary, "replaced\n");
  assert.equal(await readFile(paths.summary, "utf8"), "replaced\n");
  assert.deepEqual(
    (await readdir(join(storage, "runs", "2025"))).filter((f) => f.endsWith(".tmp")),
    [],
  );
  assert.match(renderEventSummary(store.state), /ready, 1 attempts, 1 submissions/);
});
