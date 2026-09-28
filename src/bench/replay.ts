import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SILENT_NOTIFIER } from "../alerts/notifier.ts";
import type { AocClient } from "../aoc/client.ts";
import { AocError } from "../aoc/client.ts";
import { parsePuzzlePage } from "../aoc/parse.ts";
import { type DayResult, type RunOptions, runEvent } from "../app.ts";
import { formatCredits } from "../budget/credits.ts";
import { CreditLedger } from "../budget/ledger.ts";
import type { BocConfig } from "../config.ts";
import { type PartNumber, type PuzzleId, puzzleId } from "../state/ids.ts";
import { type Layout, layout, writeFileAtomic } from "../state/layout.ts";
import { type RunState, RunStore } from "../state/run-state.ts";

/**
 * Model benchmark by replay (PLAN.md, "solver model choice"). The normal solve
 * loop runs against puzzles BoC already solved. Statements and inputs come from
 * a source run's private cache, and proposals are judged against the answer AoC
 * accepted there. Nothing contacts AoC, and the session cookie is never read.
 * The accepted answers stay in the orchestrator: the solver sees only what a
 * live run would (statement, input, feedback, and part 1's answer for part 2).
 * Model calls are real and ledger-admitted in the bench config's own storage.
 */

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

export interface ReplaySource {
  readonly paths: Layout;
  readonly state: RunState;
}

/** Synthetic replies in the site's long-standing wording (see parse.ts). */
export const REPLAY_CORRECT =
  "<main><article><p>That's the right answer! (replay)</p></article></main>";
export const REPLAY_WRONG =
  "<main><article><p>That's not the right answer. Please wait one minute before trying again. (replay)</p></article></main>";

/**
 * AoC client over a source's cache. `solvedPart1` seeds days whose part 1 the
 * bench already solved (restart). The part 2 page is served only after the bench
 * solved part 1, and every page must show exactly the answers the bench earned.
 */
export function createReplayClient(options: {
  readonly year: number;
  readonly sources: ReadonlyMap<number, ReplaySource>;
  readonly solvedPart1: Iterable<number>;
}): AocClient {
  const part1Solved = new Set(options.solvedPart1);
  const source = (year: number, day: number) => {
    const found = year === options.year ? options.sources.get(day) : undefined;
    if (!found) throw new AocError("not-available", "No replay source for this day.", 404, false);
    return found;
  };
  const accepted = (year: number, day: number, part: PartNumber) =>
    source(year, day).state.puzzles[puzzleId(day)]?.parts[part].solvedAnswer;
  return {
    prepare: async () => {},
    fetchPuzzle: async (year, day) => {
      const part: PartNumber = part1Solved.has(day) ? 2 : 1;
      const html = await readFile(source(year, day).paths.statement(puzzleId(day), part), "utf8");
      // A page showing the answer being solved would leak it to the solver.
      if (parsePuzzlePage(html).acceptedAnswers.length !== part - 1) {
        throw new ReplayError(`Cached day ${day} part ${part} page shows unexpected answers.`);
      }
      return html;
    },
    fetchInput: async (year, day) => readFile(source(year, day).paths.input(puzzleId(day)), "utf8"),
    submitAnswer: async (year, day, part, answer) => {
      const expected = accepted(year, day, part);
      if (expected === undefined) throw new ReplayError(`Day ${day} part ${part} has no answer.`);
      if (answer.trim() !== expected) return REPLAY_WRONG;
      if (part === 1) part1Solved.add(day);
      return REPLAY_CORRECT;
    },
  };
}

export async function loadReplaySources(
  year: number,
  configs: readonly BocConfig[],
): Promise<Map<number, ReplaySource>> {
  const sources = new Map<number, ReplaySource>();
  for (const config of configs) {
    if (config.event.year !== year) throw new ReplayError("Source event year differs.");
    const paths = layout(config.storageDir, year);
    const state = await RunStore.inspect({ directory: paths.runs, eventYear: year });
    for (const puzzle of Object.values(state.puzzles)) {
      if (puzzle.parts[1].status !== "solved") continue;
      const day = Number(puzzle.puzzle.slice(4));
      if (sources.has(day)) throw new ReplayError(`Day ${day} has more than one source.`);
      sources.set(day, { paths, state });
    }
  }
  return sources;
}

export interface PartMetrics {
  readonly puzzle: PuzzleId;
  readonly part: PartNumber;
  /**
   * `failed`: the part gave up. `unfinished`: the run stopped first (e.g. a provider
   * usage limit), so it is not scored. `skipped`: nothing to benchmark (source
   * unsolved, or a model-free final-day button).
   */
  readonly outcome: "correct" | "failed" | "unfinished" | "skipped";
  readonly attempts: number;
  readonly submissions: number;
  readonly firstSubmissionCorrect: boolean;
  /** Real time from the first attempt's start to the correct verdict (virtual waits excluded). */
  readonly seconds: number | undefined;
  /** Attempts that ended on a provider or agent error. */
  readonly errorAttempts: number;
}

export interface ReplayReport {
  readonly model: string;
  readonly year: number;
  readonly parts: readonly PartMetrics[];
  /** Native credits per day from the bench ledger. */
  readonly credits: Readonly<Record<string, string>>;
  readonly results: readonly DayResult[];
}

export interface ReplayOptions
  extends Omit<RunOptions, "aocClient" | "pastOnly" | "now" | "sleep"> {
  readonly sources: readonly BocConfig[];
  readonly days: readonly number[];
  /** Real clock; injected for tests. */
  readonly clock?: () => number;
}

export async function replayEvent(options: ReplayOptions): Promise<ReplayReport> {
  const { config } = options;
  const year = config.event.year;
  const bench = resolve(config.storageDir);
  if (options.sources.some((s) => resolve(s.storageDir) === bench)) {
    throw new ReplayError("The bench storage must differ from every source's storage.");
  }
  const sources = await loadReplaySources(year, options.sources);
  const missing = options.days.filter((day) => !sources.has(day));
  if (missing.length > 0)
    throw new ReplayError(`No solved source for day(s) ${missing.join(",")}.`);
  const paths = layout(config.storageDir, year);
  const before = await RunStore.inspect({ directory: paths.runs, eventYear: year });
  const solvedPart1 = Object.values(before.puzzles)
    .filter((p) => p.parts[1].status === "solved")
    .map((p) => Number(p.puzzle.slice(4)));

  // Virtual waits: server embargoes are simulated, not slept.
  const clock = options.clock ?? Date.now;
  let skipped = 0;
  const now = () => new Date(clock() + skipped);
  const timeline: { at: number; message: string }[] = [];
  const results = await runEvent({
    notifier: SILENT_NOTIFIER, // Benchmarks never page the operator.
    ...options,
    days: [...options.days],
    pastOnly: true,
    aocClient: createReplayClient({ year, sources, solvedPart1 }),
    now,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      skipped += ms;
    },
    onEvent: (message) => {
      timeline.push({ at: clock(), message });
      options.onEvent?.(message);
    },
  });

  const state = await RunStore.inspect({ directory: paths.runs, eventYear: year });
  const ledger = await CreditLedger.inspect({ directory: paths.ledger, config });
  const parts: PartMetrics[] = [];
  for (const day of options.days) {
    const puzzle = puzzleId(day);
    for (const part of [1, 2] as const) {
      const source = sources.get(day)?.state.puzzles[puzzle]?.parts[part];
      const bench = state.puzzles[puzzle]?.parts[part];
      const prefix = `${puzzle} part ${part}: `;
      const events = timeline.filter((e) => e.message.startsWith(prefix));
      const start = events.find((e) => /attempt \d+ started/.test(e.message))?.at;
      const end = events.find((e) => e.message.endsWith("verdict: correct"))?.at;
      const modelFree = events.some((e) => e.message.includes("final-day button"));
      const skip = source?.status !== "solved" || modelFree;
      parts.push({
        puzzle,
        part,
        outcome: skip
          ? "skipped"
          : bench?.status === "solved"
            ? "correct"
            : bench?.status === "gave-up"
              ? "failed"
              : "unfinished",
        attempts: bench?.attempts ?? 0,
        submissions: bench?.submissions.length ?? 0,
        firstSubmissionCorrect: bench?.submissions[0]?.verdict === "correct",
        seconds:
          start !== undefined && end !== undefined
            ? Math.round((end - start) / 100) / 10
            : undefined,
        errorAttempts: events.filter((e) => /ended without an answer \(error\)/.test(e.message))
          .length,
      });
    }
  }
  const credits: Record<string, string> = {};
  for (const counter of ledger.counters) {
    if (counter.scope === "subscription" && counter.period.startsWith("day-")) {
      credits[counter.period] = formatCredits(counter.spent);
    }
  }
  const report: ReplayReport = {
    model: config.subscriptions.map((s) => s.model).join(","),
    year,
    parts,
    credits,
    results,
  };
  await writeFileAtomic(`${paths.runs}/replay-report.json`, `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

export function renderReplayReport(report: ReplayReport): string[] {
  const lines = [`Replay ${report.year} with ${report.model}:`];
  const scored = report.parts.filter((p) => p.outcome === "correct" || p.outcome === "failed");
  for (const p of report.parts) {
    lines.push(
      `${p.puzzle} part ${p.part}: ${p.outcome}, ${p.attempts} attempt(s), ${p.submissions} submission(s)` +
        `${p.seconds !== undefined ? `, ${p.seconds} s` : ""}${p.errorAttempts ? `, ${p.errorAttempts} error attempt(s)` : ""}`,
    );
  }
  const correct = scored.filter((p) => p.outcome === "correct").length;
  const first = scored.filter((p) => p.firstSubmissionCorrect).length;
  lines.push(
    `Correct: ${correct}/${scored.length}; first submission correct: ${first}/${scored.length}.`,
  );
  return lines;
}
