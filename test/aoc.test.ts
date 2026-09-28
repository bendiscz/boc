import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isReleased, releaseTime, waitForRelease } from "../src/aoc/calendar.ts";
import { type AocClient, AocError, createAocClient } from "../src/aoc/client.ts";
import {
  DEFAULT_COOLDOWN_WAIT_MS,
  DEFAULT_INCORRECT_WAIT_MS,
  parseAnswerResponse,
  parseDuration,
  parsePuzzlePage,
  WAIT_MARGIN_MS,
} from "../src/aoc/parse.ts";
import { AocService } from "../src/aoc/service.ts";
import { puzzleId } from "../src/state/ids.ts";
import { layout } from "../src/state/layout.ts";
import { RunStore } from "../src/state/run-state.ts";

// All HTML below is synthetic: it imitates page structure, not real puzzle content.
const COOKIE = "c0ffee".repeat(16);
const main = (inner: string) =>
  `<html><body><main><article><p>${inner}</p></article></main></body></html>`;
const page = (opts: { user?: boolean; articles?: number; answers?: string[]; level?: 1 | 2 }) =>
  `<html><body><header>${opts.user === false ? "" : '<div class="user">synthetic-user</div>'}</header><main>${'<article class="day-desc"><h2>--- Synthetic ---</h2><p>Synthetic text.</p></article>'.repeat(opts.articles ?? 1)}${(opts.answers ?? []).map((a) => `<p>Your puzzle answer was <code>${a}</code>.</p>`).join("")}${opts.level ? `<form method="post" action="1/answer"><input type="hidden" name="level" value="${opts.level}"/><input type="text" name="answer"/></form>` : ""}${(opts.answers?.length ?? 0) >= 2 ? "<p>Both parts of this puzzle are complete! They provide two gold stars: **</p>" : ""}</main></body></html>`;

async function tmp(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "boc-aoc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("answer responses map to verdicts with conservative waits", () => {
  const cases: [string, string, number | undefined][] = [
    ["That's the right answer! You are one gold star closer.", "correct", undefined],
    [
      "That's not the right answer; your answer is too high. Please wait 5 minutes before trying again.",
      "too-high",
      300_000 + WAIT_MARGIN_MS,
    ],
    [
      "That's not the right answer; your answer is too low. Please wait one minute before trying again.",
      "too-low",
      60_000 + WAIT_MARGIN_MS,
    ],
    [
      "That's not the right answer. (You guessed <span>x</span>.)",
      "incorrect",
      DEFAULT_INCORRECT_WAIT_MS,
    ],
    [
      "You gave an answer too recently; you have to wait. You have 1m 30s left to wait.",
      "cooldown",
      90_000 + WAIT_MARGIN_MS,
    ],
    ["You gave an answer too recently.", "cooldown", DEFAULT_COOLDOWN_WAIT_MS],
    [
      "You don't seem to be solving the right level. Did you already complete it?",
      "uncertain",
      undefined,
    ],
    ["Something new and unexpected.", "uncertain", undefined],
    ["That&#39;s the right answer!", "correct", undefined],
  ];
  for (const [text, verdict, waitMs] of cases) {
    const result = parseAnswerResponse(main(text));
    assert.equal(result.verdict, verdict, text);
    assert.equal(result.waitMs, waitMs, text);
    assert.match(result.reason, /^[a-z][a-z0-9-]*$/);
  }
  assert.equal(parseAnswerResponse("").verdict, "uncertain");
  assert.equal(parseDuration("42s"), 42_000);
  assert.equal(parseDuration("an hour"), 3_600_000);
  assert.equal(parseDuration("soon"), undefined);
});

test("puzzle pages expose login, parts, accepted answers, and form level", () => {
  assert.deepEqual(parsePuzzlePage(page({ level: 1 })), {
    loggedIn: true,
    articles: 1,
    acceptedAnswers: [],
    answerLevel: 1,
    fixedAnswer: undefined,
    complete: false,
  });
  // A normal text answer input is not a fixed answer; a hidden one is (any attribute order).
  const text = '<input type="hidden" name="level" value="2"/><input type="text" name="answer"/>';
  assert.equal(parsePuzzlePage(text).fixedAnswer, undefined);
  const button = "<input name='answer' value=\"0\" type=HIDDEN>";
  assert.equal(parsePuzzlePage(button).fixedAnswer, "0");
  const done = parsePuzzlePage(page({ articles: 2, answers: ["12", "a&amp;b"] }));
  assert.deepEqual(done.acceptedAnswers, ["12", "a&b"]);
  assert.equal(done.complete, true);
  assert.equal(parsePuzzlePage(page({ user: false })).loggedIn, false);
});

test("release times follow midnight EST; waiting sleeps, never polls", async () => {
  assert.equal(releaseTime(2025, 1).toISOString(), "2025-12-01T05:00:00.000Z");
  assert.equal(isReleased(2025, 2, new Date("2025-12-02T04:59:59.999Z")), false);
  assert.equal(isReleased(2025, 2, new Date("2025-12-02T05:00:00.000Z")), true);
  assert.throws(() => releaseTime(2025, 0));
  let now = Date.parse("2025-12-01T04:58:00.000Z");
  const sleeps: number[] = [];
  await waitForRelease(2025, 1, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    marginMs: 1_000,
  });
  assert.equal(now, Date.parse("2025-12-01T05:00:01.000Z"));
  assert.deepEqual(sleeps, [60_000, 60_000, 1_000]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForRelease(2025, 1, { now: () => 0, sleep: async () => {}, signal: controller.signal }),
  );
});

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

async function cookieFile(t: test.TestContext, content = `${COOKIE}\n`, mode = 0o600) {
  const path = join(await tmp(t), "aoc-session");
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

test("client pins host, identifies itself, spaces requests, and never leaks the cookie", async (t) => {
  const fetch = fakeFetch([
    new Response("synthetic page"),
    new Response("1 2 3\n"),
    new Response("answer page"),
    new Response("nope", { status: 404 }),
    new Response("", { status: 302, headers: { location: "https://elsewhere.invalid/" } }),
    new Response("Puzzle inputs differ by user.", { status: 400 }),
    new Response("oops", { status: 500 }),
    new TypeError(`connect failed ${COOKIE}`),
  ]);
  let now = 1_000_000;
  const sleeps: number[] = [];
  const client = createAocClient({
    cookieFile: await cookieFile(t),
    contact: "ops@example.invalid",
    version: "0.1.0",
    fetch: fetch.impl,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    rateCap: { max: 5, windowMs: 60_000 },
  });
  const results = await Promise.all([
    client.fetchPuzzle(2025, 1),
    client.fetchInput(2025, 1),
    client.submitAnswer(2025, 1, 2, "a&b=c"),
  ]);
  assert.deepEqual(results, ["synthetic page", "1 2 3\n", "answer page"]);
  assert.deepEqual(
    fetch.calls.map((c) => [c.init.method, c.url]),
    [
      ["GET", "https://adventofcode.com/2025/day/1"],
      ["GET", "https://adventofcode.com/2025/day/1/input"],
      ["POST", "https://adventofcode.com/2025/day/1/answer"],
    ],
  );
  assert.deepEqual(sleeps, [], "a puzzle/input/answer burst is not artificially delayed");
  const headers = fetch.calls[2]?.init.headers as Record<string, string>;
  assert.equal(headers.Cookie, `session=${COOKIE}`);
  assert.match(headers["User-Agent"] ?? "", /contact: ops@example\.invalid/);
  assert.equal(fetch.calls[2]?.init.body, "level=2&answer=a%26b%3Dc");
  assert.equal(fetch.calls[2]?.init.redirect, "manual");

  const expectations: [string, boolean][] = [
    ["not-available", true],
    ["auth", true],
    ["auth", true],
    ["http", true],
    ["network", true],
  ];
  for (const [code, reached] of expectations) {
    await assert.rejects(client.fetchPuzzle(2025, 1), (e) => {
      assert.ok(e instanceof AocError);
      assert.equal(e.code, code);
      assert.equal(e.mayHaveReachedServer, reached);
      assert.doesNotMatch(`${e.message} ${e.stack}`, new RegExp(COOKIE));
      assert.doesNotMatch(e.message, /adventofcode|elsewhere/);
      return true;
    });
  }
  await assert.rejects(
    client.fetchPuzzle(2014, 1),
    (e) => e instanceof AocError && !e.mayHaveReachedServer,
  );
  await assert.rejects(client.submitAnswer(2025, 1, 1, "has space"), /Invalid answer/);
  assert.equal(fetch.calls.length, 8, "invalid requests are never sent");
  assert.ok(sleeps.length > 0, "8 starts against a cap of 5 per minute engage the brake");
});

test("client refuses unsafe cookie files, missing contact, and oversized responses", async (t) => {
  const make = async (path: string, contact: string | null = "ops@example.invalid") =>
    createAocClient({
      cookieFile: path,
      contact: contact ?? undefined,
      version: "0",
      fetch: fakeFetch([new Response("x".repeat(5 * 1024 * 1024))]).impl,
      rateCap: { max: 100, windowMs: 1 },
    });
  const config = (e: unknown) => e instanceof AocError && e.code === "config";
  await assert.rejects(
    async () => (await make(await cookieFile(t, COOKIE, 0o644))).fetchInput(2025, 1),
    config,
  );
  await assert.rejects(
    async () => (await make(await cookieFile(t, "short"))).fetchInput(2025, 1),
    config,
  );
  await assert.rejects(
    async () => (await make(join(await tmp(t), "missing"))).fetchInput(2025, 1),
    config,
  );
  await assert.rejects(async () => make(await cookieFile(t), null), config);
  await assert.rejects(async () => make(await cookieFile(t), "x (y)"), config);
  const ok = await make(await cookieFile(t, `session=${COOKIE}`));
  await assert.rejects(
    ok.fetchInput(2025, 1),
    (e) => e instanceof AocError && e.code === "too-large",
  );
});

function scriptedClient() {
  const queue: (string | AocError)[] = [];
  const calls: string[] = [];
  const control = { prepareError: undefined as AocError | undefined };
  const take = (label: string) => {
    calls.push(label);
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected ${label}`);
    if (next instanceof AocError) throw next;
    return next;
  };
  const client: AocClient = {
    prepare: async () => {
      if (control.prepareError) throw control.prepareError;
    },
    fetchPuzzle: async (_y, d) => take(`puzzle ${d}`),
    fetchInput: async (_y, d) => take(`input ${d}`),
    submitAnswer: async (_y, d, p, a) => take(`answer ${d}/${p}=${a}`),
  };
  return { client, queue, calls, control };
}

async function service(t: test.TestContext) {
  const root = await tmp(t);
  const paths = layout(root, 2025);
  let now = Date.parse("2025-12-01T05:00:05.000Z");
  const clock = () => new Date(now);
  const store = await RunStore.open({ directory: paths.runs, eventYear: 2025, now: clock });
  t.after(() => store.close().catch(() => {}));
  const scripted = scriptedClient();
  const svc = new AocService({ client: scripted.client, store, paths, year: 2025, now: clock });
  const advance = (ms: number) => {
    now += ms;
  };
  return { ...scripted, svc, store, paths, advance, root };
}

const day = puzzleId(1);

async function propose(store: RunStore, part: 1 | 2, attempt: number, answer: string) {
  await store.record({ type: "attempt-started", puzzle: day, part, attempt, subscription: "s" });
  await store.record({
    type: "attempt-finished",
    puzzle: day,
    part,
    attempt,
    outcome: "answer",
    answer,
  });
}

test("service caches downloads, submits once per proposal, and unlocks part 2", async (t) => {
  const f = await service(t);
  f.queue.push(page({ level: 1 }), "synthetic input\n");
  await f.svc.statement(day, 1);
  assert.equal(await f.svc.input(day), "synthetic input\n");
  assert.equal(await f.svc.input(day), "synthetic input\n");
  await f.svc.statement(day, 1);
  assert.deepEqual(f.calls, ["puzzle 1", "input 1"], "cached, not re-downloaded");
  await assert.rejects(f.svc.statement(day, 2), /not unlocked/);

  await propose(f.store, 1, 1, "100");
  f.queue.push(
    main(
      "That's not the right answer; your answer is too high. Please wait one minute before trying again.",
    ),
  );
  await f.svc.submit(day, 1);
  assert.equal(f.store.state.puzzles[day]?.parts[1].status, "ready");
  await propose(f.store, 1, 2, "50");
  await assert.rejects(f.svc.submit(day, 1), /cooldown/);
  f.advance(62_000);
  f.queue.push(main("That's the right answer!"));
  await f.svc.submit(day, 1);
  assert.equal(f.store.state.puzzles[day]?.parts[1].status, "solved");
  await assert.rejects(f.svc.submit(day, 1), /Nothing proposed/);

  f.queue.push(page({ articles: 2, answers: ["50"], level: 2 }));
  await f.svc.statement(day, 2);
  assert.equal(f.store.state.puzzles[day]?.parts[2].status, "ready");
  assert.deepEqual(f.calls.slice(-3), ["answer 1/1=100", "answer 1/1=50", "puzzle 1"]);
});

test("unknown submission outcomes become uncertain and are reconciled by reading only", async (t) => {
  const f = await service(t);
  f.queue.push(page({ level: 1 }), "input\n");
  await f.svc.statement(day, 1);
  await f.svc.input(day);
  await propose(f.store, 1, 1, "7");
  f.queue.push(new AocError("timeout", "AoC request timed out.", undefined, true));
  await f.svc.submit(day, 1);
  assert.equal(f.store.state.puzzles[day]?.parts[1].status, "uncertain");
  await assert.rejects(f.svc.submit(day, 1), /Nothing proposed|Submission blocked/);

  f.queue.push(page({ user: false }));
  assert.equal(await f.svc.reconcile(day, 1), "still-uncertain");
  f.queue.push(page({ answers: ["8"], articles: 2 }));
  await assert.rejects(f.svc.reconcile(day, 1), /different accepted answer/);
  f.queue.push(page({ level: 1 }));
  assert.equal(await f.svc.reconcile(day, 1), "not-correct");
  assert.equal(f.store.state.puzzles[day]?.parts[1].status, "ready");

  await propose(f.store, 1, 2, "9");
  f.queue.push(main("You don't seem to be solving the right level."));
  await f.svc.submit(day, 1);
  f.queue.push(page({ answers: ["9"], articles: 2, level: 2 }));
  assert.equal(await f.svc.reconcile(day, 1), "correct");
  assert.equal(f.store.state.puzzles[day]?.parts[1].solvedAnswer, "9");
  assert.ok(f.calls.every((c) => !c.startsWith("answer") || /=(7|9)$/.test(c)));
  assert.equal(f.calls.filter((c) => c.startsWith("answer")).length, 2);
});

test("a file written before a crash is adopted instead of downloaded again", async (t) => {
  const f = await service(t);
  const { writeFileAtomic } = await import("../src/state/layout.ts");
  await writeFileAtomic(f.paths.input(day), "adopted input\n");
  await writeFileAtomic(f.paths.statement(day, 1), page({ level: 1 }));
  assert.equal(await f.svc.input(day), "adopted input\n");
  await f.svc.statement(day, 1);
  assert.deepEqual(f.calls, []);
  assert.ok(f.store.state.puzzles[day]?.inputSha256);
  // A recorded input that disappears is not silently re-downloaded.
  await rm(f.paths.input(day));
  await assert.rejects(f.svc.input(day), /operator review/);
});

test("locally provable non-dispatch leaves the answer submittable", async (t) => {
  const f = await service(t);
  f.queue.push(page({ level: 1 }), "input\n");
  await f.svc.statement(day, 1);
  await f.svc.input(day);
  await propose(f.store, 1, 1, "7");
  f.control.prepareError = new AocError("config", "Cannot read the session cookie file.");
  await assert.rejects(f.svc.submit(day, 1), /session cookie/);
  assert.equal(f.store.state.puzzles[day]?.parts[1].submissions.length, 0, "no write-ahead record");
  f.control.prepareError = undefined;
  f.queue.push(new AocError("config", "Invalid answer submission."));
  await f.svc.submit(day, 1);
  const part = f.store.state.puzzles[day]?.parts[1];
  assert.equal(part?.status, "proposed");
  assert.equal(part?.submissions[0]?.verdict, "not-sent");
  f.queue.push(main("That's the right answer!"));
  await f.svc.submit(day, 1);
  assert.equal(f.store.state.puzzles[day]?.parts[1].status, "solved");
});

test("the rate cap brakes runaway loops without delaying a normal burst", async (t) => {
  let now = 0;
  const starts: number[] = [];
  const brakes: number[] = [];
  const impl = (async () => {
    starts.push(now);
    return new Response("ok");
  }) as typeof fetch;
  const client = createAocClient({
    cookieFile: await cookieFile(t),
    contact: "ops@example.invalid",
    version: "0",
    fetch: impl,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rateCap: { max: 3, windowMs: 60_000 },
    onBrake: (ms) => brakes.push(ms),
  });
  for (let i = 0; i < 7; i++) await client.fetchPuzzle(2025, 1);
  assert.deepEqual(starts, [0, 0, 0, 60_000, 60_000, 60_000, 120_000]);
  assert.deepEqual(brakes, [60_000, 60_000], "every brake wait is reported");
  assert.throws(() =>
    createAocClient({
      cookieFile: "x",
      contact: "ops@example.invalid",
      version: "0",
      rateCap: { max: 0, windowMs: 1 },
    }),
  );
});
