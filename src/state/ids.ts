// Puzzle identifiers within one event. The event (year) scopes the ledger and
// artifacts; do not hardcode an event's day count here. December has 31 days,
// so this is a syntactic bound only, not a calendar claim.
declare const puzzleBrand: unique symbol;
export type PuzzleId = string & { readonly [puzzleBrand]: true };

const PUZZLE_PATTERN = /^day-(0[1-9]|[12][0-9]|3[01])(?![\s\S])/;

export function isPuzzleId(value: unknown): value is PuzzleId {
  return typeof value === "string" && PUZZLE_PATTERN.test(value);
}

export function puzzleId(day: number): PuzzleId {
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("Invalid puzzle day.");
  return `day-${String(day).padStart(2, "0")}` as PuzzleId;
}

export type PartNumber = 1 | 2;

export function isPartNumber(value: unknown): value is PartNumber {
  return value === 1 || value === 2;
}

/**
 * Attempt and submission numbers are 1-based sequences per puzzle part. Paths and
 * display keys use a zero-padded form, e.g. `day-01/part-2/attempt-003`.
 */
export const MAX_SEQUENCE = 999;

export function isSequence(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SEQUENCE
  );
}

export function attemptKey(puzzle: PuzzleId, part: PartNumber, attempt: number): string {
  if (!isPuzzleId(puzzle) || !isPartNumber(part) || !isSequence(attempt)) {
    throw new Error("Invalid attempt identifier.");
  }
  return `${puzzle}/part-${part}/attempt-${String(attempt).padStart(3, "0")}`;
}

/** AoC answers: printable ASCII without whitespace, bounded length. */
const ANSWER_PATTERN = /^[\x21-\x7e]{1,200}(?![\s\S])/;

export function isAnswer(value: unknown): value is string {
  return typeof value === "string" && ANSWER_PATTERN.test(value);
}
