import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { attemptKey, isPartNumber, isPuzzleId, type PartNumber, type PuzzleId } from "./ids.ts";
import { ensurePrivateDirectory, syncDirectory } from "./journal.ts";

/**
 * Private artifact layout under `storageDir` (never committed; see D005):
 *
 *   INDEX.md                                   readable index of events
 *   ledger/<year>/journal.jsonl                credit ledger (D012)
 *   runs/<year>/journal.jsonl                  run-state journal
 *   runs/<year>/SUMMARY.md                     readable event summary (regenerated)
 *   runs/<year>/events.log                     append-only timestamped run log
 *   puzzles/<year>/<day-NN>/README.md          readable puzzle summary (regenerated)
 *   puzzles/<year>/<day-NN>/part-<P>.html      raw statement response (private)
 *   puzzles/<year>/<day-NN>/input.txt          personal input (private)
 *   puzzles/<year>/<day-NN>/part-<P>/attempt-<NNN>/   workspace, transcript, logs
 *
 * Journals are authoritative; Markdown files are derived views and can be rebuilt.
 */
export interface Layout {
  readonly root: string;
  readonly index: string;
  readonly ledger: string;
  readonly runs: string;
  readonly summary: string;
  readonly eventLog: string;
  puzzle(puzzle: PuzzleId): string;
  puzzleReadme(puzzle: PuzzleId): string;
  statement(puzzle: PuzzleId, part: PartNumber): string;
  input(puzzle: PuzzleId): string;
  attempt(puzzle: PuzzleId, part: PartNumber, attempt: number): string;
}

export function layout(storageDir: string, eventYear: number): Layout {
  if (!Number.isInteger(eventYear)) throw new Error("Invalid event year.");
  const year = String(eventYear);
  const puzzles = join(storageDir, "puzzles", year);
  const puzzleDir = (puzzle: PuzzleId) => {
    if (!isPuzzleId(puzzle)) throw new Error("Invalid puzzle identifier.");
    return join(puzzles, puzzle);
  };
  return {
    root: storageDir,
    index: join(storageDir, "INDEX.md"),
    ledger: join(storageDir, "ledger", year),
    runs: join(storageDir, "runs", year),
    summary: join(storageDir, "runs", year, "SUMMARY.md"),
    eventLog: join(storageDir, "runs", year, "events.log"),
    puzzle: puzzleDir,
    puzzleReadme: (puzzle) => join(puzzleDir(puzzle), "README.md"),
    statement: (puzzle, part) => {
      if (!isPartNumber(part)) throw new Error("Invalid part.");
      return join(puzzleDir(puzzle), `part-${part}.html`);
    },
    input: (puzzle) => join(puzzleDir(puzzle), "input.txt"),
    attempt: (puzzle, part, attempt) => join(puzzles, attemptKey(puzzle, part, attempt)),
  };
}

/**
 * Crash-safe private file replacement: write a temporary sibling (0600), fsync,
 * rename over the target, fsync the directory. Readers see old or new, never partial.
 */
export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await syncDirectory(directory);
}
