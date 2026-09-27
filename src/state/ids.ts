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
