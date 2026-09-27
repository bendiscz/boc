import { type FileHandle, mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { z } from "zod";

/**
 * Append-only JSON-lines journal with single-writer ownership.
 *
 * - Every record is validated, written in full, and fsynced before `append`
 *   resolves; callers must not act on a record before that.
 * - Records carry a contiguous `seq` from 1. A torn final line (never fsynced
 *   as complete, so never acknowledged) is truncated on open; any other
 *   malformed or out-of-order content refuses to open.
 * - An exclusive lock file (O_EXCL) excludes other processes. `run` serializes
 *   in-process operations so check-then-append sequences are atomic.
 * - A write/sync failure faults the journal for the rest of the process.
 *
 * Errors are fixed strings: never include paths, record content, or raw I/O errors.
 */

export const JOURNAL_FILE = "journal.jsonl";
export const LOCK_FILE = "journal.lock";

export type JournalErrorCode = "locked" | "corrupt" | "faulted" | "invalid" | "closed";

export class JournalError extends Error {
  readonly code: JournalErrorCode;
  constructor(code: JournalErrorCode, message: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

export interface JournalRecord {
  readonly seq: number;
  readonly at: string;
}

type Body<R> = R extends unknown ? Omit<R, "seq" | "at"> : never;

export interface JournalOptions<R extends JournalRecord> {
  readonly directory: string;
  readonly schema: z.ZodType<R>;
  readonly now?: () => Date;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Create a private directory (0700) and make its entry durable. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(directory));
}

export class Journal<R extends JournalRecord> {
  readonly #directory: string;
  readonly #schema: z.ZodType<R>;
  readonly #now: () => Date;
  #handle: FileHandle | undefined;
  #seq = 0;
  #faulted = false;
  #closed = false;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(options: JournalOptions<R>) {
    this.#directory = options.directory;
    this.#schema = options.schema;
    this.#now = options.now ?? (() => new Date());
  }

  /** Opens (creating if needed) and returns all durable records for replay. */
  static async open<R extends JournalRecord>(
    options: JournalOptions<R>,
  ): Promise<{ journal: Journal<R>; records: R[] }> {
    const journal = new Journal(options);
    await ensurePrivateDirectory(options.directory);
    await acquireLock(options.directory);
    try {
      const records = await journal.#load();
      return { journal, records };
    } catch (error) {
      await journal.#handle?.close().catch(() => {});
      await unlink(join(options.directory, LOCK_FILE)).catch(() => {});
      if (error instanceof JournalError) throw error;
      throw new JournalError("corrupt", "Cannot open the journal.");
    }
  }

  /**
   * Remove a lock left by a dead process on this host. Refuses when the owner may
   * still be alive or belongs to another host; PID reuse errs on the side of refusal
   * (the operator may then remove the lock manually after review).
   */
  static async breakStaleLock(directory: string): Promise<void> {
    let owner: { pid?: unknown; host?: unknown };
    try {
      owner = JSON.parse(await readFile(join(directory, LOCK_FILE), "utf8"));
    } catch (error) {
      if (isNotFound(error)) return;
      throw new JournalError("locked", "Lock is unreadable; remove it manually after review.");
    }
    if (owner.host !== hostname() || typeof owner.pid !== "number") {
      throw new JournalError("locked", "Lock belongs to another host or is malformed.");
    }
    try {
      process.kill(owner.pid, 0);
      throw new JournalError("locked", "Lock owner is still running.");
    } catch (error) {
      if (error instanceof JournalError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new JournalError("locked", "Cannot determine whether the lock owner is running.");
      }
    }
    await unlink(join(directory, LOCK_FILE));
  }

  get faulted(): boolean {
    return this.#faulted;
  }

  get empty(): boolean {
    return this.#seq === 0;
  }

  async #load(): Promise<R[]> {
    const path = join(this.#directory, JOURNAL_FILE);
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const end = content.lastIndexOf("\n") + 1;
    if (end !== content.length) {
      // Torn tail: never fsynced as a complete record, so never acknowledged.
      const handle = await open(path, "r+");
      try {
        await handle.truncate(Buffer.byteLength(content.slice(0, end)));
        await handle.sync();
      } finally {
        await handle.close();
      }
      content = content.slice(0, end);
    }
    this.#handle = await open(path, "a", 0o600);
    await syncDirectory(this.#directory);
    const records: R[] = [];
    if (!content) return records;
    for (const [index, line] of content.slice(0, -1).split("\n").entries()) {
      let record: R;
      try {
        record = this.#schema.parse(JSON.parse(line));
      } catch {
        throw new JournalError("corrupt", "Journal is corrupt.");
      }
      if (record.seq !== index + 1) throw new JournalError("corrupt", "Journal is corrupt.");
      records.push(record);
      this.#seq = record.seq;
    }
    return records;
  }

  /** Serialize an operation; rejects immediately when closed, and when faulted. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new JournalError("closed", "Journal is closed."));
    const result = this.#tail.then(() => {
      if (this.#faulted) throw new JournalError("faulted", "Journal is faulted.");
      return operation();
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  /** Durably append. Call only from inside `run` (or during single-threaded setup). */
  async append(body: Body<R>): Promise<R> {
    if (!this.#handle) throw new JournalError("closed", "Journal is closed.");
    if (this.#faulted) throw new JournalError("faulted", "Journal is faulted.");
    const candidate = { seq: this.#seq + 1, at: this.#now().toISOString(), ...body };
    // Validate what is written so that replay can never reject our own output.
    const parsed = this.#schema.safeParse(candidate);
    if (!parsed.success) throw new JournalError("invalid", "Invalid journal record.");
    try {
      // appendFile loops until the whole line is written (O_APPEND positions it).
      await this.#handle.appendFile(`${JSON.stringify(candidate)}\n`, "utf8");
      await this.#handle.sync();
    } catch {
      this.#faulted = true;
      throw new JournalError("faulted", "Journal write failed; the journal is faulted.");
    }
    this.#seq = candidate.seq;
    return parsed.data;
  }

  /**
   * Rejects new operations immediately; operations queued earlier drain first,
   * then the file and lock are released.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    await this.#handle?.close();
    this.#handle = undefined;
    await unlink(join(this.#directory, LOCK_FILE));
  }
}

async function acquireLock(directory: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(join(directory, LOCK_FILE), "wx", 0o600);
  } catch {
    throw new JournalError("locked", "Locked by another process.");
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() })}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}
