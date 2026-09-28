import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";
import { puzzleText } from "../aoc/parse.ts";
import type { AocService } from "../aoc/service.ts";
import { LedgerError } from "../budget/ledger.ts";
import {
  type Admission,
  createGuardedStreams,
  PROVIDER_REFUSALS,
  RUNAWAY_MESSAGES,
} from "../pi/guarded-streams.ts";
import type { Executor } from "../sandbox/executor.ts";
import { Workspace } from "../sandbox/workspace.ts";
import type { PartNumber, PuzzleId } from "../state/ids.ts";
import { type Layout, writeFileAtomic } from "../state/layout.ts";
import {
  answerRejection,
  type RunStore,
  StateError,
  submissionBlocker,
} from "../state/run-state.ts";
import { abortableSleep } from "../util/sleep.ts";
import { createSolverAgent } from "./agent.ts";
import { SOLVER_SYSTEM_PROMPT, taskPrompt } from "./prompt.ts";
import { createSolverTools } from "./tools.ts";

/**
 * Trusted orchestration of one puzzle: fetch (cached) → attempt in a fresh
 * workspace → propose → submit (write-ahead, embargo-aware) → next attempt or
 * part 2. Every state change goes through RunStore; every model call through
 * the guarded, ledger-admitted streams. Restart-safe: the loop resumes from the
 * recorded part status.
 */

export interface SolverBinding {
  readonly subscription: string;
  readonly model: Model<Api>;
  /** Ledger-backed admission scoped to this subscription and puzzle. */
  readonly admission: Admission;
  /** Trusted provider transport; wrapped in the guard for every attempt. */
  readonly transport: ProviderStreams;
  readonly outputCap?: number;
}

export interface SolveOptions {
  readonly year: number;
  readonly puzzle: PuzzleId;
  readonly store: RunStore;
  readonly aoc: AocService;
  readonly paths: Layout;
  readonly executor: Executor;
  /** Chooses the subscription/model for the next attempt, or undefined if none can run. */
  readonly binding: (part: PartNumber, attempt: number) => SolverBinding | undefined;
  readonly maxAttemptsPerPart?: number;
  readonly maxTurnsPerAttempt?: number;
  /** Wall-clock limit per model response (default 120 s; normal turns took under 40 s). */
  readonly maxResponseMs?: number;
  /** Longest silence within a response stream (default 60 s). */
  readonly stallMs?: number;
  /** Attempt deadline, checked between turns so no call is ever aborted (default 10 min). */
  readonly maxAttemptMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly onEvent?: (message: string) => void;
}

export type PartOutcome =
  | "solved"
  | "gave-up"
  | "uncertain"
  | "unavailable"
  /** Part 2 offers no answer form (the final day before every other star is earned). */
  | "needs-stars"
  | "provider-fault"
  /** The provider refused requests (usage limit, rejected credential); attempts are kept. */
  | "provider-unavailable"
  | "no-subscription";

export async function solvePuzzle(options: SolveOptions) {
  const part1 = await solvePart(options, 1);
  if (part1 !== "solved") return { part1, part2: undefined };
  const part2 = await solvePart(options, 2);
  return { part1, part2 };
}

export async function solvePart(options: SolveOptions, part: PartNumber): Promise<PartOutcome> {
  const { store, aoc, puzzle } = options;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const maxAttempts = options.maxAttemptsPerPart ?? 4;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 999) {
    throw new Error("maxAttemptsPerPart must be an integer from 1 to 999.");
  }
  const log = (message: string) => options.onEvent?.(`${puzzle} part ${part}: ${message}`);

  for (;;) {
    options.signal?.throwIfAborted();
    const partState = store.state.puzzles[puzzle]?.parts[part];
    const status = partState?.status ?? "locked";
    switch (status) {
      case "solved":
        return "solved";
      case "gave-up":
        return "gave-up";
      case "locked":
        try {
          await aoc.statement(puzzle, part);
        } catch (error) {
          if (error instanceof StateError) return "unavailable";
          throw error;
        }
        log("statement fetched");
        break;
      case "uncertain": {
        const result = await aoc.reconcile(puzzle, part);
        log(`uncertain submission reconciled: ${result}`);
        if (result === "still-uncertain") return "uncertain";
        break;
      }
      case "proposed": {
        const answer = partState?.proposed?.answer ?? "";
        const blocker = submissionBlocker(store.state, puzzle, part, answer, now());
        if (blocker === "cooldown") {
          const until = Date.parse(store.state.submitNotBefore ?? "");
          const wait = Math.max(0, until - now().getTime());
          log(`waiting ${Math.ceil(wait / 1000)} s for the answer cooldown`);
          await sleep(wait, options.signal);
        } else if (blocker) {
          log(`proposal discarded (${blocker})`);
          await store.record({ type: "proposal-discarded", puzzle, part, reason: blocker });
        } else {
          log(`submitting ${answer}`);
          await aoc.submit(puzzle, part);
          const verdict = store.state.puzzles[puzzle]?.parts[part].submissions.at(-1)?.verdict;
          log(`verdict: ${verdict}`);
        }
        break;
      }
      case "ready": {
        if ((partState?.attempts ?? 0) >= maxAttempts) {
          await store.record({ type: "part-gave-up", puzzle, part, reason: "attempt-limit" });
          log("attempt limit reached");
          break;
        }
        if (part === 2) {
          // Never spend credits on a part that cannot be submitted.
          const form = await aoc.answerForm(puzzle, part);
          if (form.kind === "none") {
            log("no answer form (the final day needs every other star first)");
            return "needs-stars";
          }
          if (form.kind === "fixed") {
            await proposeFixed(options, part, form.answer, log);
            break;
          }
        }
        const outcome = await runAttempt(options, part, log);
        if (outcome) return outcome;
        break;
      }
      default:
        // `solving`/`submitting` are resolved by RunStore recovery on open.
        throw new StateError(`Unexpected part status ${status}.`);
    }
  }
}

/**
 * The final day's part 2 has no puzzle: the page's button posts a fixed value.
 * The orchestrator proposes it as a model-free attempt; the normal submission
 * path (write-ahead, embargo, duplicate refusal) then applies unchanged.
 */
async function proposeFixed(
  options: SolveOptions,
  part: PartNumber,
  answer: string,
  log: (message: string) => void,
): Promise<void> {
  const { store, puzzle } = options;
  const before = store.state.puzzles[puzzle]?.parts[part];
  const judged = (verdict: string) => verdict !== "not-sent" && verdict !== "cooldown";
  if (before?.submissions.some((s) => s.answer === answer && judged(s.verdict))) {
    await store.record({ type: "part-gave-up", puzzle, part, reason: "fixed-answer-rejected" });
    log("the final-day button was already pressed without success");
    return;
  }
  const attempt = (before?.attempts ?? 0) + 1;
  await store.record({
    type: "attempt-started",
    puzzle,
    part,
    attempt,
    subscription: "orchestrator",
  });
  await store.record({
    type: "attempt-finished",
    puzzle,
    part,
    attempt,
    outcome: "answer",
    answer,
  });
  log(`attempt ${attempt}: final-day button (no model call)`);
}

async function runAttempt(
  options: SolveOptions,
  part: PartNumber,
  log: (message: string) => void,
): Promise<PartOutcome | undefined> {
  const { store, aoc, puzzle, paths } = options;
  const before = store.state.puzzles[puzzle]?.parts[part];
  const attempt = (before?.attempts ?? 0) + 1;
  const binding = options.binding(part, attempt);
  if (!binding) {
    log("no eligible subscription");
    return "no-subscription";
  }
  const html = await aoc.statement(puzzle, part);
  const input = await aoc.input(puzzle);
  const articles = puzzleText(html).slice(0, part);
  // Prepare the workspace before recording the attempt. A directory for this
  // not-yet-recorded attempt number can only be debris from a crash: replace it.
  const attemptDir = paths.attempt(puzzle, part, attempt);
  await rm(attemptDir, { recursive: true, force: true });
  const workspace = await Workspace.create(join(attemptDir, "work"), ["input.txt"]);
  await workspace.place("input.txt", input);
  const copied = await carryOverFiles(options, part, attempt, workspace);
  await store.record({
    type: "attempt-started",
    puzzle,
    part,
    attempt,
    subscription: binding.subscription,
  });
  log(`attempt ${attempt} started (${binding.subscription})`);

  let denied = false;
  let faulted = false;
  const providerErrors: string[] = [];
  const cutoffs: { reason: string; content: unknown }[] = [];
  const previousAttempt =
    attempt > 1 ? await previousAttemptEnding(options, part, attempt - 1) : undefined;
  const admission: Admission = {
    reserve: async (request) => {
      try {
        return await binding.admission.reserve(request);
      } catch (error) {
        if (error instanceof LedgerError && error.code === "denied") denied = true;
        throw error;
      }
    },
  };
  const streams = createGuardedStreams({
    model: binding.model,
    admission,
    transport: binding.transport,
    ...(binding.outputCap ? { outputCap: binding.outputCap } : {}),
    onFault: () => {
      faulted = true;
    },
    onProviderError: (raw) => {
      providerErrors.push(raw);
    },
    onCutoff: (partial, reason) => {
      cutoffs.push({ reason, content: partial.content });
    },
    maxResponseMs: options.maxResponseMs ?? DEFAULT_MAX_RESPONSE_MS,
    stallMs: options.stallMs ?? DEFAULT_STALL_MS,
  });
  const attemptStart = Date.now();
  let timedOut = false;
  const tools = createSolverTools({
    workspace,
    executor: options.executor,
    onProposal: (answer) => log(`attempt ${attempt} proposed ${answer}`),
    refuse: (answer) => {
      const partState = store.state.puzzles[puzzle]?.parts[part];
      const why = partState ? answerRejection(partState, answer) : undefined;
      if (!why) return undefined;
      log(`attempt ${attempt}: refused proposal ${answer} (${why})`);
      return REFUSAL_TEXT[why];
    },
  });
  const agent = createSolverAgent({
    model: binding.model,
    streams,
    systemPrompt: SOLVER_SYSTEM_PROMPT,
    tools: tools.tools,
    maxTurns: options.maxTurnsPerAttempt ?? 40,
    shouldStop: () => {
      if (tools.proposed() !== undefined) return true;
      if (Date.now() - attemptStart < (options.maxAttemptMs ?? DEFAULT_MAX_ATTEMPT_MS))
        return false;
      timedOut = true;
      return true;
    },
  });
  const abort = () => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let agentError = false;
  try {
    const partState = store.state.puzzles[puzzle]?.parts[part];
    if (!partState) throw new StateError("Missing part state.");
    await agent.prompt(
      taskPrompt({
        year: options.year,
        day: Number(puzzle.slice(4)),
        part,
        articles,
        inputLines: input.split("\n").length,
        inputBytes: Buffer.byteLength(input),
        partState,
        ...(part === 2 && store.state.puzzles[puzzle]?.parts[1].solvedAnswer
          ? { part1Answer: store.state.puzzles[puzzle]?.parts[1].solvedAnswer as string }
          : {}),
        copiedFiles: copied,
        ...(previousAttempt ? { previousAttempt } : {}),
      }),
    );
  } catch {
    agentError = true;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    // Private transcript beside (not inside) the container-visible workspace.
    await writeFileAtomic(
      join(attemptDir, "transcript.json"),
      `${JSON.stringify(agent.state.messages, null, 1)}\n`,
    ).catch(() => log("transcript could not be written"));
    if (cutoffs.length > 0) {
      // Private diagnostics: what a stopped runaway response contained.
      await writeFileAtomic(
        join(attemptDir, "cutoff-partial.json"),
        `${JSON.stringify(cutoffs, null, 1)}\n`,
      ).catch(() => {});
    }
    if (timedOut) {
      await writeFileAtomic(join(attemptDir, "time-limit"), "attempt deadline reached\n").catch(
        () => {},
      );
    }
    if (providerErrors.length > 0) {
      // Private diagnostics; the log and the model only see a safe category.
      await writeFileAtomic(
        join(attemptDir, "provider-error.txt"),
        `${providerErrors.join("\n---\n")}\n`,
      ).catch(() => {});
    }
  }

  // Evidence for tuning the output cap (EVALUATION.md): a cap that is too low
  // shows up as truncated responses and failed attempts.
  const capped = agent.state.messages.filter(isRunaway).length;
  if (capped > 0) log(`attempt ${attempt}: ${capped} response(s) hit the output cap or time limit`);
  if (timedOut) log(`attempt ${attempt}: attempt time limit reached`);

  const answer = tools.proposed();
  const where = { type: "attempt-finished" as const, puzzle, part, attempt };
  if (answer !== undefined) {
    // The answer came from settled turns; a later fault only holds a reservation.
    await store.record({ ...where, outcome: "answer", answer });
    if (faulted) {
      log(`attempt ${attempt}: provider outcome uncertain (reservation held); stopping`);
      return "provider-fault";
    }
    return undefined;
  }
  if (options.signal?.aborted) {
    await store.record({ ...where, outcome: "interrupted" });
    options.signal.throwIfAborted();
  }
  if (denied) {
    await store.record({ ...where, outcome: "budget-exhausted" });
    log(`attempt ${attempt} stopped: credits exhausted`);
    return "gave-up";
  }
  await store.record({ ...where, outcome: "failed" });
  const limited = agent.state.messages.findLast(
    (m) =>
      m.role === "assistant" &&
      PROVIDER_REFUSALS.some((prefix) => m.errorMessage?.startsWith(prefix)),
  );
  if (limited && limited.role === "assistant") {
    // Retrying now would only burn attempts; stop and keep the rest for later.
    log(`attempt ${attempt} stopped: ${limited.errorMessage}`);
    return "provider-unavailable";
  }
  if (faulted) {
    log(`attempt ${attempt} stopped: provider outcome uncertain (reservation held)`);
    return "provider-fault";
  }
  log(`attempt ${attempt} ended without an answer${agentError ? " (error)" : ""}`);
  return undefined;
}

const REFUSAL_TEXT = {
  "duplicate-answer":
    "This answer was already submitted and judged wrong. Find the bug in your solution; do not propose it again.",
  "contradicts-too-low":
    "This answer contradicts earlier feedback: the answer is known to be higher. Find the bug.",
  "contradicts-too-high":
    "This answer contradicts earlier feedback: the answer is known to be lower. Find the bug.",
} as const;

const DEFAULT_MAX_RESPONSE_MS = 120_000;
const DEFAULT_STALL_MS = 60_000;
const DEFAULT_MAX_ATTEMPT_MS = 600_000;

function isRunaway(m: { role: string; stopReason?: string; errorMessage?: string }): boolean {
  return (
    m.role === "assistant" &&
    (m.stopReason === "length" || RUNAWAY_MESSAGES.some((message) => m.errorMessage === message))
  );
}

/** Why an earlier attempt ended, from its private artifacts (restart-safe). */
async function previousAttemptEnding(
  options: SolveOptions,
  part: PartNumber,
  attempt: number,
): Promise<"runaway-response" | "time-limit" | undefined> {
  const dir = options.paths.attempt(options.puzzle, part, attempt);
  try {
    const messages = JSON.parse(await readFile(join(dir, "transcript.json"), "utf8")) as {
      role: string;
      stopReason?: string;
      errorMessage?: string;
    }[];
    if (Array.isArray(messages) && messages.some(isRunaway)) return "runaway-response";
  } catch {
    // No readable transcript: nothing known.
  }
  try {
    await readFile(join(dir, "time-limit"));
    return "time-limit";
  } catch {
    return undefined;
  }
}

/**
 * Carry work forward: a retry starts from the previous attempt's files for the
 * same part; part 2's first attempt starts from the attempt that solved part 1.
 */
async function carryOverFiles(
  options: SolveOptions,
  part: PartNumber,
  attempt: number,
  target: Workspace,
): Promise<string[]> {
  let sourcePart: PartNumber = part;
  let sourceAttempt: number | undefined = attempt > 1 ? attempt - 1 : undefined;
  if (sourceAttempt === undefined && part === 2) {
    const part1 = options.store.state.puzzles[options.puzzle]?.parts[1];
    sourcePart = 1;
    sourceAttempt = part1?.submissions.find((s) => s.verdict === "correct")?.attempt;
  }
  if (sourceAttempt === undefined) return [];
  const source = new Workspace(
    join(options.paths.attempt(options.puzzle, sourcePart, sourceAttempt), "work"),
  );
  const copied: string[] = [];
  // Missing or unreadable earlier files only reduce context; solving continues.
  const entries = await source.list().catch(() => []);
  for (const entry of entries) {
    if (entry.path === "input.txt") continue;
    try {
      await target.write(entry.path, await source.readAll(entry.path));
      copied.push(entry.path);
    } catch {
      // Skip this file; copy the rest.
    }
  }
  return copied;
}
