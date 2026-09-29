import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  isAnswer,
  isPartNumber,
  isPuzzleId,
  isSequence,
  type PartNumber,
  type PuzzleId,
} from "./ids.ts";
import { Journal, JournalError } from "./journal.ts";

/**
 * Durable puzzle/part progress for one event, as a validated state machine over a
 * journal (see `journal.ts`). Every transition is checked before it is written, and
 * replay applies the same checks, so the journal cannot describe an impossible run.
 *
 * Part lifecycle:
 *
 *   locked ──statement──▶ ready ──attempt-started──▶ solving
 *   solving ──finished(answer)──▶ proposed;
 *           (failed|interrupted|refused|budget-exhausted)──▶ ready
 *   proposed ──submission-started (write-ahead, before HTTP)──▶ submitting
 *   submitting ──correct──▶ solved; incorrect/too-high/too-low──▶ ready;
 *              cooldown/not-sent (not judged)──▶ proposed; uncertain──▶ uncertain
 *   uncertain ──reconciled(correct)──▶ solved; (not-correct)──▶ ready
 *   proposed ──proposal-discarded (e.g. blocked duplicate)──▶ ready
 *   ready|proposed ──gave-up──▶ gave-up
 *   ready|proposed ──adopted (the page already shows an accepted answer)──▶ solved
 *
 * Part 2 cannot become ready until part 1 is solved. On open, an interrupted
 * `solving` part is recorded as `interrupted` and an interrupted `submitting`
 * part as `uncertain`: an unknown submission is never retried automatically.
 * A judged answer is never submitted twice for the same part, and integer
 * answers contradicting a too-high/too-low verdict are rejected.
 */

export const RUN_STATE_VERSION = 1;

export type PartStatus =
  | "locked"
  | "ready"
  | "solving"
  | "proposed"
  | "submitting"
  | "uncertain"
  | "solved"
  | "gave-up";

/**
 * `cooldown`: the server refused to judge. `not-sent`: the client failed before
 * dispatch (proven locally), so the answer was not judged either. Both return the
 * part to `proposed` and do not count as a judged answer.
 */
export type Verdict =
  | "correct"
  | "incorrect"
  | "too-high"
  | "too-low"
  | "cooldown"
  | "not-sent"
  | "uncertain";

const UNJUDGED: readonly string[] = ["cooldown", "not-sent"];

export interface SubmissionState {
  readonly submission: number;
  readonly attempt: number;
  readonly answer: string;
  /** `pending` only while submitting; reconciled uncertain outcomes are replaced. */
  readonly verdict: Verdict | "pending" | "not-correct";
}

export interface PartState {
  readonly status: PartStatus;
  readonly statementSha256: string | undefined;
  readonly attempts: number;
  /** Attempts a provider refused before the model ran; not counted against the attempt cap. */
  readonly refusedAttempts: number;
  readonly activeAttempt: number | undefined;
  readonly proposed: { readonly attempt: number; readonly answer: string } | undefined;
  readonly submissions: readonly SubmissionState[];
  /** Integer answers must be strictly greater than this (from too-low). */
  readonly lowerBound: string | undefined;
  /** Integer answers must be strictly less than this (from too-high). */
  readonly upperBound: string | undefined;
  readonly solvedAnswer: string | undefined;
  readonly gaveUpReason: string | undefined;
  /** Subscription of the most recent attempt (display only; the ledger is authoritative). */
  readonly lastSubscription: string | undefined;
}

export interface PuzzleState {
  readonly puzzle: PuzzleId;
  readonly inputSha256: string | undefined;
  readonly parts: { readonly 1: PartState; readonly 2: PartState };
}

export interface RunState {
  readonly eventYear: number;
  readonly puzzles: Readonly<Record<string, PuzzleState>>;
  /** Event-wide conservative submission embargo from the latest server wait. */
  readonly submitNotBefore: string | undefined;
}

const puzzle = z.string().refine(isPuzzleId);
const part = z.number().refine(isPartNumber);
const sequence = z.number().refine(isSequence);
const answer = z.string().refine(isAnswer);
const sha256 = z.string().regex(/^[0-9a-f]{64}(?![\s\S])/);
const reason = z.string().regex(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/);
const base = { seq: z.number().int().min(1), at: z.iso.datetime() };
const where = { puzzle, part };

const recordSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("create"),
    version: z.literal(RUN_STATE_VERSION),
    eventYear: z.number().int(),
    store: z.uuid(),
  }),
  z.strictObject({ ...base, type: z.literal("open"), session: z.uuid() }),
  z.strictObject({ ...base, type: z.literal("statement-fetched"), ...where, sha256 }),
  z.strictObject({ ...base, type: z.literal("input-fetched"), puzzle, sha256 }),
  z.strictObject({
    ...base,
    type: z.literal("attempt-started"),
    ...where,
    attempt: sequence,
    subscription: reason,
  }),
  z.strictObject({
    ...base,
    type: z.literal("attempt-finished"),
    ...where,
    attempt: sequence,
    outcome: z.enum(["answer", "failed", "interrupted", "budget-exhausted", "refused"]),
    answer: answer.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("submission-started"),
    ...where,
    submission: sequence,
    attempt: sequence,
    answer,
  }),
  z.strictObject({
    ...base,
    type: z.literal("submission-finished"),
    ...where,
    submission: sequence,
    verdict: z.enum([
      "correct",
      "incorrect",
      "too-high",
      "too-low",
      "cooldown",
      "not-sent",
      "uncertain",
    ]),
    retryAfter: z.iso.datetime().optional(),
    reason: reason.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("submission-reconciled"),
    ...where,
    submission: sequence,
    verdict: z.enum(["correct", "not-correct"]),
    evidence: reason,
  }),
  z.strictObject({ ...base, type: z.literal("proposal-discarded"), ...where, reason }),
  z.strictObject({
    ...base,
    type: z.literal("submission-not-judged"),
    ...where,
    submission: sequence,
    note: reason,
  }),
  z.strictObject({ ...base, type: z.literal("part-gave-up"), ...where, reason }),
  // The puzzle page already shows this part's accepted answer (solved outside this
  // storage, e.g. an earlier run or by hand): adopt it; never solve or submit again.
  z.strictObject({
    ...base,
    type: z.literal("part-adopted"),
    ...where,
    answer,
    evidence: reason,
  }),
]);

export type RunRecord = z.infer<typeof recordSchema>;
type Body<R> = R extends unknown ? Omit<R, "seq" | "at"> : never;
export type RunEvent = Body<Exclude<RunRecord, { type: "create" | "open" }>>;

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

const EMPTY_PART: PartState = {
  status: "locked",
  statementSha256: undefined,
  attempts: 0,
  refusedAttempts: 0,
  activeAttempt: undefined,
  proposed: undefined,
  submissions: [],
  lowerBound: undefined,
  upperBound: undefined,
  solvedAnswer: undefined,
  gaveUpReason: undefined,
  lastSubscription: undefined,
};

function isInteger(value: string): boolean {
  return /^-?(0|[1-9][0-9]*)(?![\s\S])/.test(value);
}

/** Why a candidate answer is already known to be wrong for this part, if it is. */
export function answerRejection(
  partState: PartState,
  candidate: string,
): "duplicate-answer" | "contradicts-too-low" | "contradicts-too-high" | undefined {
  const same = partState.submissions.filter((s) => s.answer === candidate);
  const judged = same.some((s) => !UNJUDGED.includes(s.verdict) && s.verdict !== "not-correct");
  // `not-correct` comes only from reconciling an unknown outcome while the level was
  // still open: AoC may never have judged it. One automatic resubmission is allowed
  // (operator decision, D026); its verdict is final, and a second unknown blocks it.
  const unknown = same.filter((s) => s.verdict === "not-correct").length;
  if (judged || unknown > 1) return "duplicate-answer";
  if (isInteger(candidate)) {
    const value = BigInt(candidate);
    if (partState.lowerBound !== undefined && value <= BigInt(partState.lowerBound)) {
      return "contradicts-too-low";
    }
    if (partState.upperBound !== undefined && value >= BigInt(partState.upperBound)) {
      return "contradicts-too-high";
    }
  }
  return undefined;
}

/** Reasons a proposed answer may not be submitted now; undefined when allowed. */
export function submissionBlocker(
  state: RunState,
  puzzleId: PuzzleId,
  partNumber: PartNumber,
  candidate: string,
  now: Date,
): string | undefined {
  const partState = state.puzzles[puzzleId]?.parts[partNumber];
  if (partState?.status !== "proposed") return "part-not-proposed";
  if (partState.proposed?.answer !== candidate) return "answer-not-proposed";
  const rejection = answerRejection(partState, candidate);
  if (rejection) return rejection;
  if (state.submitNotBefore && now.getTime() < Date.parse(state.submitNotBefore)) {
    return "cooldown";
  }
  return undefined;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Pure transition. Throws StateError for any transition the lifecycle forbids. */
export function transition(state: RunState, record: RunRecord): RunState {
  const deny = (why: string): never => {
    throw new StateError(`Invalid run-state transition: ${why}.`);
  };
  if (record.type === "create" || record.type === "open") return state;
  const puzzleId = record.puzzle as PuzzleId;
  const existing = state.puzzles[puzzleId];
  const puzzles = { ...state.puzzles };
  let submitNotBefore = state.submitNotBefore;

  if (record.type === "input-fetched") {
    const current = existing ?? {
      puzzle: puzzleId,
      inputSha256: undefined,
      parts: { 1: EMPTY_PART, 2: EMPTY_PART },
    };
    if (current.inputSha256 && current.inputSha256 !== record.sha256) deny("input changed");
    puzzles[puzzleId] = { ...current, inputSha256: record.sha256 };
    return { ...state, puzzles };
  }

  const partNumber = record.part as PartNumber;
  const current = existing ?? {
    puzzle: puzzleId,
    inputSha256: undefined,
    parts: { 1: EMPTY_PART, 2: EMPTY_PART },
  };
  const before = current.parts[partNumber];
  const next: Mutable<PartState> = { ...before };

  switch (record.type) {
    case "statement-fetched":
      if (partNumber === 2 && current.parts[1].status !== "solved") deny("part 1 unsolved");
      if (before.status === "locked") next.status = "ready";
      next.statementSha256 = record.sha256;
      break;
    case "attempt-started":
      if (before.status !== "ready") deny("part not ready");
      if (!current.inputSha256) deny("input missing");
      if (record.attempt !== before.attempts + 1) deny("attempt out of sequence");
      next.status = "solving";
      next.attempts = record.attempt;
      next.activeAttempt = record.attempt;
      next.lastSubscription = record.subscription;
      break;
    case "attempt-finished":
      if (before.status !== "solving" || before.activeAttempt !== record.attempt) {
        deny("no such active attempt");
      }
      if ((record.outcome === "answer") !== (record.answer !== undefined)) deny("answer mismatch");
      next.activeAttempt = undefined;
      if (record.outcome === "answer" && record.answer !== undefined) {
        next.status = "proposed";
        next.proposed = { attempt: record.attempt, answer: record.answer };
      } else if (record.outcome === "refused") {
        next.status = "ready";
        next.refusedAttempts = before.refusedAttempts + 1;
      } else {
        // `budget-exhausted` counts as an attempt; the part fails over (the solve loop
        // excludes that subscription) and gives up only through `part-gave-up`.
        next.status = "ready";
      }
      break;
    case "submission-started": {
      const blocker = submissionBlocker(
        state,
        puzzleId,
        partNumber,
        record.answer,
        new Date(record.at),
      );
      if (blocker) deny(blocker);
      if (record.submission !== before.submissions.length + 1) deny("submission out of sequence");
      if (before.proposed?.attempt !== record.attempt) deny("attempt mismatch");
      next.status = "submitting";
      next.submissions = [
        ...before.submissions,
        {
          submission: record.submission,
          attempt: record.attempt,
          answer: record.answer,
          verdict: "pending",
        },
      ];
      break;
    }
    case "submission-finished": {
      const last = before.submissions.at(-1);
      if (before.status !== "submitting" || last?.submission !== record.submission) {
        deny("no such pending submission");
      }
      if (!last) return deny("no such pending submission");
      next.submissions = [...before.submissions.slice(0, -1), { ...last, verdict: record.verdict }];
      if (record.retryAfter) {
        if (!submitNotBefore || Date.parse(record.retryAfter) > Date.parse(submitNotBefore)) {
          submitNotBefore = record.retryAfter;
        }
      }
      switch (record.verdict) {
        case "correct":
          next.status = "solved";
          next.solvedAnswer = last.answer;
          next.proposed = undefined;
          break;
        case "cooldown":
        case "not-sent":
          next.status = "proposed";
          break;
        case "uncertain":
          next.status = "uncertain";
          break;
        default:
          next.status = "ready";
          next.proposed = undefined;
          if (record.verdict === "too-low" && isInteger(last.answer)) {
            if (!before.lowerBound || BigInt(last.answer) > BigInt(before.lowerBound)) {
              next.lowerBound = last.answer;
            }
          }
          if (record.verdict === "too-high" && isInteger(last.answer)) {
            if (!before.upperBound || BigInt(last.answer) < BigInt(before.upperBound)) {
              next.upperBound = last.answer;
            }
          }
      }
      break;
    }
    case "submission-reconciled": {
      const last = before.submissions.at(-1);
      if (before.status !== "uncertain" || last?.submission !== record.submission) {
        deny("no such uncertain submission");
      }
      if (!last) return deny("no such uncertain submission");
      next.submissions = [...before.submissions.slice(0, -1), { ...last, verdict: record.verdict }];
      next.proposed = undefined;
      if (record.verdict === "correct") {
        next.status = "solved";
        next.solvedAnswer = last.answer;
      } else {
        next.status = "ready";
      }
      break;
    }
    case "submission-not-judged": {
      // Operator override: evidence shows AoC never judged this submission (e.g. an
      // auth rejection). The answer becomes submittable again; nothing is resubmitted
      // automatically unless the part is (re)proposed.
      const index = before.submissions.findIndex((s) => s.submission === record.submission);
      const target = before.submissions[index];
      if (!target || (target.verdict !== "not-correct" && target.verdict !== "uncertain")) {
        deny("submission is not overridable");
      }
      if (!target) return deny("submission is not overridable");
      if (target.verdict === "uncertain" && index !== before.submissions.length - 1) {
        deny("submission is not the latest");
      }
      const submissions = [...before.submissions];
      submissions[index] = { ...target, verdict: "not-sent" };
      next.submissions = submissions;
      // Never resubmit on the override itself: an uncertain part returns to ready,
      // so only a fresh proposal can submit the answer again.
      if (before.status === "uncertain") {
        next.status = "ready";
        next.proposed = undefined;
      }
      break;
    }
    case "proposal-discarded":
      if (before.status !== "proposed") deny("nothing proposed");
      next.status = "ready";
      next.proposed = undefined;
      break;
    case "part-adopted":
      if (before.status !== "ready" && before.status !== "proposed") deny("part not idle");
      next.status = "solved";
      next.solvedAnswer = record.answer;
      next.proposed = undefined;
      break;
    case "part-gave-up":
      if (before.status !== "ready" && before.status !== "proposed") deny("part not idle");
      next.status = "gave-up";
      next.gaveUpReason = record.reason;
      next.proposed = undefined;
      break;
  }
  puzzles[puzzleId] = { ...current, parts: { ...current.parts, [partNumber]: next } };
  return { ...state, puzzles, submitNotBefore };
}

export interface RunStoreOptions {
  readonly directory: string;
  readonly eventYear: number;
  readonly now?: () => Date;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class RunStore {
  readonly #journal: Journal<RunRecord>;
  #state: RunState;

  private constructor(journal: Journal<RunRecord>, state: RunState) {
    this.#journal = journal;
    this.#state = state;
  }

  static #replay(records: readonly RunRecord[], eventYear: number): RunState {
    let state: RunState = deepFreeze({ eventYear, puzzles: {}, submitNotBefore: undefined });
    for (const [index, record] of records.entries()) {
      if ((index === 0) !== (record.type === "create")) {
        throw new JournalError("corrupt", "Run-state journal is corrupt.");
      }
      if (record.type === "create" && record.eventYear !== eventYear) {
        throw new StateError("Run state belongs to a different event.");
      }
      try {
        state = deepFreeze(transition(state, record));
      } catch {
        throw new JournalError("corrupt", "Run-state journal is inconsistent.");
      }
    }
    return state;
  }

  /** Read-only view without the lock; interrupted work is shown as-is, not recovered. */
  /** See `Journal.breakStaleLock`. */
  static async breakStaleLock(directory: string): Promise<boolean> {
    return await Journal.breakStaleLock(directory);
  }

  static async inspect(options: Omit<RunStoreOptions, "now">): Promise<RunState> {
    const records = await Journal.read({ directory: options.directory, schema: recordSchema });
    return RunStore.#replay(records, options.eventYear);
  }

  static async open(options: RunStoreOptions): Promise<RunStore> {
    const { journal, records } = await Journal.open({
      directory: options.directory,
      schema: recordSchema,
      ...(options.now ? { now: options.now } : {}),
    });
    try {
      const state = RunStore.#replay(records, options.eventYear);
      if (journal.empty) {
        await journal.append({
          type: "create",
          version: RUN_STATE_VERSION,
          eventYear: options.eventYear,
          store: randomUUID(),
        });
      }
      await journal.append({ type: "open", session: randomUUID() });
      const store = new RunStore(journal, state);
      await store.#recoverInterrupted();
      return store;
    } catch (error) {
      await journal.close().catch(() => {});
      throw error;
    }
  }

  /** Crash recovery: interrupted work is recorded, never resumed as if nothing happened. */
  async #recoverInterrupted(): Promise<void> {
    for (const puzzleState of Object.values(this.#state.puzzles)) {
      for (const partNumber of [1, 2] as const) {
        const partState = puzzleState.parts[partNumber];
        const where = { puzzle: puzzleState.puzzle, part: partNumber };
        if (partState.status === "solving" && partState.activeAttempt !== undefined) {
          await this.record({
            type: "attempt-finished",
            ...where,
            attempt: partState.activeAttempt,
            outcome: "interrupted",
          });
        } else if (partState.status === "submitting") {
          await this.record({
            type: "submission-finished",
            ...where,
            submission: partState.submissions.length,
            verdict: "uncertain",
            reason: "interrupted",
          });
        }
      }
    }
  }

  get state(): RunState {
    return this.#state;
  }

  /** Validate, durably append, then apply. Invalid transitions write nothing. */
  record(event: RunEvent): Promise<RunState> {
    return this.#journal.run(async () => {
      const at = this.#journal.now();
      const candidate = recordSchema.safeParse({ seq: 1, at: at.toISOString(), ...event });
      if (!candidate.success) throw new StateError("Invalid run-state record.");
      const next = deepFreeze(transition(this.#state, candidate.data));
      await this.#journal.append(event as never, at);
      this.#state = next;
      return next;
    });
  }

  get faulted(): boolean {
    return this.#journal.faulted;
  }

  close(): Promise<void> {
    return this.#journal.close();
  }
}
