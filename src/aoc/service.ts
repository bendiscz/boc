import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAnswer, type PartNumber, type PuzzleId } from "../state/ids.ts";
import { type Layout, writeFileAtomic } from "../state/layout.ts";
import { type RunState, type RunStore, StateError, submissionBlocker } from "../state/run-state.ts";
import { type AocClient, AocError } from "./client.ts";
import { parseAnswerResponse, parsePuzzlePage } from "./parse.ts";

/**
 * Orchestrator-side AoC workflow: cached downloads recorded in the run state,
 * write-ahead submissions, and reconciliation of uncertain outcomes from the
 * puzzle page. Raw pages and inputs are written only to private storage.
 */

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function dayOf(puzzle: PuzzleId): number {
  return Number(puzzle.slice(4));
}

export interface AocServiceOptions {
  readonly client: AocClient;
  readonly store: RunStore;
  readonly paths: Layout;
  readonly year: number;
  readonly now?: () => Date;
}

export type ReconcileOutcome = "correct" | "not-correct" | "still-uncertain";

/** What the part's answer form asks for. */
export type AnswerForm =
  | { readonly kind: "answer" }
  | { readonly kind: "fixed"; readonly answer: string }
  | { readonly kind: "none" };

export class AocService {
  readonly #client: AocClient;
  readonly #store: RunStore;
  readonly #paths: Layout;
  readonly #year: number;
  readonly #now: () => Date;

  constructor(options: AocServiceOptions) {
    this.#client = options.client;
    this.#store = options.store;
    this.#paths = options.paths;
    this.#year = options.year;
    this.#now = options.now ?? (() => new Date());
  }

  get state(): RunState {
    return this.#store.state;
  }

  async #cached(path: string, expected: string | undefined): Promise<string | undefined> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    // Unrecorded file: written atomically before a crash prevented the record.
    if (!expected) return content.length > 0 ? content : undefined;
    return sha256(content) === expected ? content : undefined;
  }

  /** Statement page for a part: cached once fetched; part 2 only after part 1 is solved. */
  async statement(puzzle: PuzzleId, part: PartNumber): Promise<string> {
    const path = this.#paths.statement(puzzle, part);
    const partState = this.state.puzzles[puzzle]?.parts[part];
    const cached = await this.#cached(path, partState?.statementSha256);
    if (cached !== undefined) {
      const page = parsePuzzlePage(cached);
      if (partState?.statementSha256) return cached;
      if (page.loggedIn && page.articles >= part) {
        await this.#store.record({
          type: "statement-fetched",
          puzzle,
          part,
          sha256: sha256(cached),
        });
        return cached;
      }
    }
    if (part === 2 && this.state.puzzles[puzzle]?.parts[1].status !== "solved") {
      throw new StateError("Part 2 is not unlocked.");
    }
    const html = await this.#client.fetchPuzzle(this.#year, dayOf(puzzle));
    const page = parsePuzzlePage(html);
    if (!page.loggedIn) throw new AocError("auth", "AoC page is not authenticated.");
    if (page.articles < part) throw new StateError("Puzzle part is not visible yet.");
    await writeFileAtomic(path, html);
    await this.#store.record({ type: "statement-fetched", puzzle, part, sha256: sha256(html) });
    return html;
  }

  /**
   * The answer form of a visible part. A form with a hidden answer is the final
   * day's part 2 button (no model needed). No form means nothing can be submitted,
   * e.g. the final day before every other star is earned; a cached page without a
   * form is refetched once per call, because earning stars elsewhere changes it.
   */
  async answerForm(puzzle: PuzzleId, part: PartNumber): Promise<AnswerForm> {
    const classify = (html: string): AnswerForm | undefined => {
      const page = parsePuzzlePage(html);
      if (page.answerLevel !== part) return undefined;
      if (page.fixedAnswer !== undefined && isAnswer(page.fixedAnswer)) {
        return { kind: "fixed", answer: page.fixedAnswer };
      }
      return { kind: "answer" };
    };
    const cached = classify(await this.statement(puzzle, part));
    if (cached) return cached;
    const html = await this.#client.fetchPuzzle(this.#year, dayOf(puzzle));
    const page = parsePuzzlePage(html);
    if (!page.loggedIn) throw new AocError("auth", "AoC page is not authenticated.");
    if (page.articles < part) throw new StateError("Puzzle part is not visible yet.");
    await writeFileAtomic(this.#paths.statement(puzzle, part), html);
    await this.#store.record({ type: "statement-fetched", puzzle, part, sha256: sha256(html) });
    return classify(html) ?? { kind: "none" };
  }

  /** Personal input: downloaded once, then always served from private cache. */
  async input(puzzle: PuzzleId): Promise<string> {
    const path = this.#paths.input(puzzle);
    const recorded = this.state.puzzles[puzzle]?.inputSha256;
    const cached = await this.#cached(path, recorded);
    if (cached !== undefined) {
      if (!recorded)
        await this.#store.record({ type: "input-fetched", puzzle, sha256: sha256(cached) });
      return cached;
    }
    if (recorded) {
      // Recorded but missing/altered locally: refuse to silently re-download.
      throw new StateError("Cached input is missing or altered; operator review needed.");
    }
    const content = await this.#client.fetchInput(this.#year, dayOf(puzzle));
    if (content.length === 0) throw new AocError("http", "AoC returned an empty input.");
    await writeFileAtomic(path, content);
    await this.#store.record({ type: "input-fetched", puzzle, sha256: sha256(content) });
    return content;
  }

  /**
   * Submit the currently proposed answer exactly once. The intent is durably
   * recorded before the request; any unknown outcome becomes `uncertain`.
   */
  async submit(puzzle: PuzzleId, part: PartNumber): Promise<RunState> {
    const partState = this.state.puzzles[puzzle]?.parts[part];
    const proposal = partState?.proposed;
    if (!partState || !proposal) throw new StateError("Nothing proposed for this part.");
    const blocker = submissionBlocker(this.state, puzzle, part, proposal.answer, this.#now());
    if (blocker) throw new StateError(`Submission blocked: ${blocker}.`);
    // Fail before the write-ahead record for anything detectable locally.
    await this.#client.prepare();
    const submission = partState.submissions.length + 1;
    await this.#store.record({
      type: "submission-started",
      puzzle,
      part,
      submission,
      attempt: proposal.attempt,
      answer: proposal.answer,
    });
    let html: string;
    try {
      html = await this.#client.submitAnswer(this.#year, dayOf(puzzle), part, proposal.answer);
    } catch (error) {
      const known = error instanceof AocError;
      const reason = known ? `transport-${error.code}` : "transport-failure";
      // Only a typed pre-dispatch failure proves the answer was not sent.
      const notSent = known && !error.mayHaveReachedServer;
      return this.#store.record({
        type: "submission-finished",
        puzzle,
        part,
        submission,
        verdict: notSent ? "not-sent" : "uncertain",
        reason,
      });
    }
    const result = parseAnswerResponse(html);
    return this.#store.record({
      type: "submission-finished",
      puzzle,
      part,
      submission,
      verdict: result.verdict,
      reason: result.reason,
      ...(result.waitMs !== undefined
        ? { retryAfter: new Date(this.#now().getTime() + result.waitMs).toISOString() }
        : {}),
    });
  }

  /** Resolve an uncertain submission by reading (not submitting to) the puzzle page. */
  async reconcile(puzzle: PuzzleId, part: PartNumber): Promise<ReconcileOutcome> {
    const partState = this.state.puzzles[puzzle]?.parts[part];
    const last = partState?.submissions.at(-1);
    if (partState?.status !== "uncertain" || !last) {
      throw new StateError("No uncertain submission for this part.");
    }
    const page = parsePuzzlePage(await this.#client.fetchPuzzle(this.#year, dayOf(puzzle)));
    if (!page.loggedIn) return "still-uncertain";
    const accepted = page.acceptedAnswers[part - 1];
    let verdict: "correct" | "not-correct";
    if (accepted !== undefined) {
      if (accepted !== last.answer) {
        throw new StateError("Page shows a different accepted answer; operator review needed.");
      }
      verdict = "correct";
    } else if (part === 2 && page.complete) {
      // The final day's part 2 shows no accepted answer, only completion.
      verdict = "correct";
    } else if (page.answerLevel === part && page.acceptedAnswers.length === part - 1) {
      verdict = "not-correct";
    } else {
      return "still-uncertain";
    }
    await this.#store.record({
      type: "submission-reconciled",
      puzzle,
      part,
      submission: last.submission,
      verdict,
      evidence: "puzzle-page",
    });
    return verdict;
  }
}
