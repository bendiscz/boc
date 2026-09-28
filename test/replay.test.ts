import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { AocClient } from "../src/aoc/client.ts";
import { runEvent } from "../src/app.ts";
import { ReplayError, renderReplayReport, replayEvent } from "../src/bench/replay.ts";
import { parseCredits } from "../src/budget/credits.ts";
import { type BocConfig, parseConfig } from "../src/config.ts";
import type { ProviderAdapter } from "../src/providers/adapter.ts";
import type { Executor } from "../src/sandbox/executor.ts";
import { puzzleId } from "../src/state/ids.ts";
import { layout } from "../src/state/layout.ts";
import { FAKE_MODEL, message, responseStream } from "./support/fake-pi.ts";

// Synthetic pages and answers only.
const ANSWERS = { 1: "alpha-111", 2: "beta-222" } as const;
const page = (articles: number, answers: string[]) =>
  `<html><header><div class="user">synthetic</div></header><main>${Array.from({ length: articles }, (_, i) => `<article class="day-desc"><p>Synthetic part ${i + 1}.</p></article>`).join("")}${answers.map((a) => `<p>Your puzzle answer was <code>${a}</code>.</p>`).join("")}<form><input type="hidden" name="level" value="${answers.length + 1}"/></form></main></html>`;
const right = "<html><main><article><p>That's the right answer!</p></article></main></html>";

const configFor = (root: string, storage: string): BocConfig =>
  parseConfig({
    version: 1,
    event: { year: 2025 },
    storageDir: join(root, storage),
    // Never created: replay must not read the session cookie.
    aoc: { sessionCookieFile: join(root, "no-cookie"), contact: "ops@example.invalid" },
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

/** Scripted model: proposes the next answer for the part named in the prompt. */
function scriptedAdapter(script: { 1: string[]; 2: string[] }, prompts: string[]): ProviderAdapter {
  const invoke = (_m: unknown, context: TranscriptContext) => {
    const text = JSON.stringify(context.messages.find((m) => m.role === "user")?.content);
    prompts.push(text);
    const part = /part 2\./.test(text) ? 2 : 1;
    const answer = script[part].shift() ?? "none";
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
}

async function solvedSource(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "boc-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = configFor(root, "source");
  let solved = false;
  const client: AocClient = {
    prepare: async () => {},
    fetchPuzzle: async () => (solved ? page(2, [ANSWERS[1]]) : page(1, [])),
    fetchInput: async () => "3\n4\n",
    submitAnswer: async (_y, _d, part) => {
      if (part === 1) solved = true;
      return right;
    },
  };
  await runEvent({
    config: source,
    version: "test",
    days: [1],
    adapters: {
      "github-copilot": async () => scriptedAdapter({ 1: [ANSWERS[1]], 2: [ANSWERS[2]] }, []),
    },
    aocClient: client,
    executor,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return { root, source };
}

test("replay judges proposals against accepted answers without contacting AoC", async (t) => {
  const { root, source } = await solvedSource(t);
  const prompts: string[] = [];
  const events: string[] = [];
  const started = Date.now();
  const report = await replayEvent({
    config: configFor(root, "bench"),
    version: "test",
    sources: [source],
    days: [1],
    adapters: {
      "github-copilot": async () =>
        scriptedAdapter({ 1: ["wrong-9", ANSWERS[1]], 2: [ANSWERS[2]] }, prompts),
    },
    executor,
    onEvent: (e) => events.push(e),
  });
  assert.ok(Date.now() - started < 30_000, "the wrong-answer embargo is virtual, not slept");
  const [p1, p2] = report.parts;
  assert.equal(p1?.outcome, "correct");
  assert.equal(p1?.attempts, 2);
  assert.equal(p1?.submissions, 2);
  assert.equal(p1?.firstSubmissionCorrect, false);
  assert.equal(p2?.outcome, "correct");
  assert.equal(p2?.firstSubmissionCorrect, true);
  assert.equal(report.credits["day-01"], "3", "three admitted model calls");
  // The solver never sees the answer it is being judged against.
  const part1Prompts = prompts.filter((p) => !/part 2\./.test(p));
  const part2Prompts = prompts.filter((p) => /part 2\./.test(p));
  assert.ok(part1Prompts.every((p) => !p.includes(ANSWERS[1]) && !p.includes(ANSWERS[2])));
  assert.ok(part2Prompts.every((p) => !p.includes(ANSWERS[2])));
  assert.match(part2Prompts[0] ?? "", /alpha-111/, "part 2 knows part 1's answer, as live");
  assert.match(
    renderReplayReport(report).join("\n"),
    /Correct: 2\/2; first submission correct: 1\/2\./,
  );
  assert.ok(events.some((e) => /verdict: incorrect/.test(e)));
});

test("replay refuses shared storage, missing sources, and pages that would leak answers", async (t) => {
  const { root, source } = await solvedSource(t);
  const base = {
    version: "test",
    adapters: { "github-copilot": async () => scriptedAdapter({ 1: [], 2: [] }, []) },
    executor,
  };
  await assert.rejects(
    replayEvent({ ...base, config: configFor(root, "source"), sources: [source], days: [1] }),
    ReplayError,
  );
  await assert.rejects(
    replayEvent({ ...base, config: configFor(root, "bench"), sources: [source], days: [2] }),
    /No solved source for day\(s\) 2/,
  );
  // A tampered part 1 page showing an answer is refused before any model call.
  const paths = layout(source.storageDir, 2025);
  await writeFile(paths.statement(puzzleId(1), 1), page(1, [ANSWERS[1]]));
  const prompts: string[] = [];
  await assert.rejects(
    replayEvent({
      ...base,
      adapters: { "github-copilot": async () => scriptedAdapter({ 1: [], 2: [] }, prompts) },
      config: configFor(root, "bench2"),
      sources: [source],
      days: [1],
    }),
    ReplayError,
  );
  assert.equal(prompts.length, 0);
});
