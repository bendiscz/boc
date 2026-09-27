import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { BocConfig } from "../config.ts";
import { isPuzzleId, type PuzzleId } from "../state/ids.ts";
import {
  addCredits,
  CREDIT_PATTERN,
  type Credits,
  formatCredits,
  isCredits,
  parseCredits,
  subtractCredits,
  ZERO_CREDITS,
} from "./credits.ts";

/**
 * Durable four-counter credit ledger for one event.
 *
 * Persistence is a single append-only JSON-lines journal. Every record is written
 * and fsynced before its effect is acknowledged, so a reservation is durable before
 * any dispatch may begin. A torn final line was never acknowledged and is dropped
 * on open; any other malformed or inconsistent content refuses to open. One process
 * owns the ledger through an exclusive lock file; within the process, all
 * operations are serialized, so check-and-reserve is atomic across workers.
 *
 * Reservations that are never settled stay held forever (including across
 * restarts) until an authoritative reconciliation settles them. Nothing here
 * releases a reservation without a recorded actual charge.
 */

export const LEDGER_VERSION = 1;
const JOURNAL = "journal.jsonl";
const LOCK = "ledger.lock";

export type LedgerErrorCode =
  | "locked"
  | "corrupt"
  | "config-mismatch"
  | "faulted"
  | "denied"
  | "invalid"
  | "closed";

/** Messages are fixed strings: never include paths, receipts, or raw I/O errors. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/);
const reservationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/);
const amount = z.string().regex(CREDIT_PATTERN);
const puzzle = z.string().refine(isPuzzleId);
/** Receipt references only; never free text that could carry secrets or puzzle content. */
const evidence = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#=-]{0,199}(?![\s\S])/);
const base = { seq: z.number().int().min(1), at: z.iso.datetime() };

const recordSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("create"),
    version: z.literal(LEDGER_VERSION),
    eventYear: z.number().int(),
    ledger: z.uuid(),
  }),
  z.strictObject({ ...base, type: z.literal("open"), session: z.uuid() }),
  z.strictObject({
    ...base,
    type: z.literal("reserve"),
    id: reservationId,
    session: z.uuid(),
    subscription: identifier,
    pool: identifier,
    provider: identifier,
    unit: identifier,
    puzzle,
    amount,
    operation: identifier,
  }),
  z.strictObject({
    ...base,
    type: z.literal("settle"),
    id: reservationId,
    actual: amount,
    evidence,
  }),
  z.strictObject({ ...base, type: z.literal("uncertain"), id: reservationId, reason: identifier }),
  z.strictObject({ ...base, type: z.literal("acknowledge"), id: reservationId, note: identifier }),
]);

type LedgerRecord = z.infer<typeof recordSchema>;
type RecordBody = LedgerRecord extends infer R
  ? R extends LedgerRecord
    ? Omit<R, "seq" | "at">
    : never
  : never;

export interface HeldReservation {
  readonly id: string;
  readonly subscription: string;
  readonly pool: string;
  readonly puzzle: PuzzleId;
  readonly amount: Credits;
  /** True if made by an earlier process: the outcome is unknown until reconciled. */
  readonly orphaned: boolean;
  /** Reason code if an outcome was recorded as uncertain. */
  readonly uncertain: string | undefined;
}

export interface CounterStatus {
  readonly scope: "subscription" | "pool";
  readonly id: string;
  readonly unit: string;
  /** "event" or a puzzle ID. */
  readonly period: "event" | PuzzleId;
  readonly limit: Credits;
  readonly spent: Credits;
  readonly reserved: Credits;
  /** Zero when exceeded; never negative. */
  readonly remaining: Credits;
  readonly exceeded: boolean;
}

export interface LedgerStatus {
  readonly eventYear: number;
  readonly fault: string | undefined;
  readonly pendingOverruns: readonly string[];
  readonly held: readonly HeldReservation[];
  readonly counters: readonly CounterStatus[];
}

export interface ReserveInput {
  readonly id: string;
  readonly subscription: string;
  readonly puzzle: PuzzleId;
  /** Certified conservative maximum charge; must be positive. */
  readonly amount: Credits;
  readonly operation: string;
}

export interface LedgerOptions {
  readonly directory: string;
  readonly config: BocConfig;
  readonly now?: () => Date;
}

interface Held {
  id: string;
  subscription: string;
  pool: string;
  puzzle: PuzzleId;
  amount: Credits;
  session: string;
  uncertain: string | undefined;
}

interface Limits {
  event: Credits;
  perPuzzle: Credits;
}

function counterKeys(subscription: string, pool: string, puzzleId: string): string[] {
  return [
    `subscription/${subscription}/event`,
    `subscription/${subscription}/${puzzleId}`,
    `pool/${pool}/event`,
    `pool/${pool}/${puzzleId}`,
  ];
}

function get(map: Map<string, Credits>, key: string): Credits {
  return map.get(key) ?? ZERO_CREDITS;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function ledgerDirectory(config: BocConfig): string {
  return join(config.storageDir, "ledger", String(config.event.year));
}

export class CreditLedger {
  readonly #directory: string;
  readonly #config: BocConfig;
  readonly #now: () => Date;
  readonly #session = randomUUID();
  readonly #subscriptionLimits = new Map<string, Limits>();
  readonly #poolLimits = new Map<string, Limits>();
  readonly #spent = new Map<string, Credits>();
  readonly #reserved = new Map<string, Credits>();
  readonly #held = new Map<string, Held>();
  readonly #known = new Set<string>();
  readonly #pendingOverruns = new Set<string>();
  readonly #puzzles = new Set<PuzzleId>();
  #handle: FileHandle | undefined;
  #seq = 0;
  #fault: string | undefined;
  #closed = false;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(options: LedgerOptions) {
    this.#directory = options.directory;
    this.#config = options.config;
    this.#now = options.now ?? (() => new Date());
    const limits = (value: { event: string; perPuzzle: string }): Limits => ({
      event: parseCredits(value.event),
      perPuzzle: parseCredits(value.perPuzzle),
    });
    for (const pool of options.config.creditPools) {
      this.#poolLimits.set(pool.id, limits(pool.limits));
    }
    for (const subscription of options.config.subscriptions) {
      this.#subscriptionLimits.set(subscription.id, limits(subscription.limits));
    }
  }

  static async open(options: LedgerOptions): Promise<CreditLedger> {
    const ledger = new CreditLedger(options);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await syncDirectory(dirname(options.directory));
    await CreditLedger.#acquireLock(options.directory);
    try {
      await ledger.#load();
      await ledger.#append({ type: "open", session: ledger.#session });
    } catch (error) {
      await ledger.#handle?.close().catch(() => {});
      await unlink(join(options.directory, LOCK)).catch(() => {});
      if (error instanceof LedgerError) throw error;
      throw new LedgerError("corrupt", "Cannot open the credit ledger.");
    }
    return ledger;
  }

  /**
   * Remove a lock left by a dead process on this host. Refuses when the owner may
   * still be alive or belongs to another host; PID reuse errs on the side of refusal.
   */
  static async breakStaleLock(directory: string): Promise<void> {
    let owner: { pid?: unknown; host?: unknown };
    try {
      owner = JSON.parse(await readFile(join(directory, LOCK), "utf8"));
    } catch (error) {
      if (isNotFound(error)) return;
      throw new LedgerError(
        "locked",
        "Ledger lock is unreadable; remove it manually after review.",
      );
    }
    if (owner.host !== hostname() || typeof owner.pid !== "number") {
      throw new LedgerError("locked", "Ledger lock belongs to another host or is malformed.");
    }
    try {
      process.kill(owner.pid, 0);
      throw new LedgerError("locked", "Ledger lock owner is still running.");
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new LedgerError("locked", "Cannot determine whether the lock owner is running.");
      }
    }
    await unlink(join(directory, LOCK));
  }

  static async #acquireLock(directory: string): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(join(directory, LOCK), "wx", 0o600);
    } catch {
      throw new LedgerError("locked", "The credit ledger is locked by another process.");
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

  async #load(): Promise<void> {
    const path = join(this.#directory, JOURNAL);
    let content: string | undefined;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (content !== undefined) {
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
    }
    this.#handle = await open(path, "a", 0o600);
    if (!content) {
      await this.#append({
        type: "create",
        version: LEDGER_VERSION,
        eventYear: this.#config.event.year,
        ledger: randomUUID(),
      });
      await syncDirectory(this.#directory);
      return;
    }
    const lines = content.slice(0, -1).split("\n");
    for (const [index, line] of lines.entries()) {
      let record: LedgerRecord;
      try {
        record = recordSchema.parse(JSON.parse(line));
      } catch {
        throw new LedgerError("corrupt", "Credit ledger journal is corrupt.");
      }
      if (record.seq !== index + 1 || (index === 0) !== (record.type === "create")) {
        throw new LedgerError("corrupt", "Credit ledger journal is corrupt.");
      }
      this.#replay(record);
      this.#seq = record.seq;
    }
  }

  #replay(record: LedgerRecord): void {
    const corrupt = () => new LedgerError("corrupt", "Credit ledger journal is inconsistent.");
    switch (record.type) {
      case "create":
        if (record.eventYear !== this.#config.event.year) {
          throw new LedgerError("config-mismatch", "Ledger belongs to a different event.");
        }
        return;
      case "open":
        return;
      case "reserve": {
        if (this.#known.has(record.id)) throw corrupt();
        // Renaming/rebinding would silently reset limits: require an explicit migration.
        const subscription = this.#config.subscriptions.find((s) => s.id === record.subscription);
        const pool = this.#config.creditPools.find((p) => p.id === record.pool);
        if (
          !subscription ||
          !pool ||
          subscription.creditPool !== pool.id ||
          subscription.provider !== record.provider ||
          pool.provider !== record.provider ||
          pool.unit !== record.unit
        ) {
          throw new LedgerError("config-mismatch", "Configuration does not match ledger history.");
        }
        this.#applyReserve({
          id: record.id,
          subscription: record.subscription,
          pool: record.pool,
          puzzle: record.puzzle as PuzzleId,
          amount: parseCredits(record.amount),
          session: record.session,
          uncertain: undefined,
        });
        return;
      }
      case "settle": {
        const held = this.#held.get(record.id);
        if (!held) throw corrupt();
        this.#applySettle(held, parseCredits(record.actual));
        return;
      }
      case "uncertain": {
        const held = this.#held.get(record.id);
        if (!held) throw corrupt();
        held.uncertain = record.reason;
        return;
      }
      case "acknowledge":
        if (!this.#pendingOverruns.delete(record.id)) throw corrupt();
        return;
    }
  }

  #applyReserve(held: Held): void {
    this.#known.add(held.id);
    this.#held.set(held.id, held);
    this.#puzzles.add(held.puzzle);
    for (const key of counterKeys(held.subscription, held.pool, held.puzzle)) {
      this.#reserved.set(key, addCredits(get(this.#reserved, key), held.amount));
    }
  }

  #applySettle(held: Held, actual: Credits): void {
    for (const key of counterKeys(held.subscription, held.pool, held.puzzle)) {
      this.#reserved.set(key, subtractCredits(get(this.#reserved, key), held.amount));
      this.#spent.set(key, addCredits(get(this.#spent, key), actual));
    }
    this.#held.delete(held.id);
    if (actual > held.amount) this.#pendingOverruns.add(held.id);
  }

  async #append(body: RecordBody): Promise<void> {
    if (!this.#handle) throw new LedgerError("closed", "Credit ledger is closed.");
    const record = { seq: this.#seq + 1, at: this.#now().toISOString(), ...body };
    // Validate what is written so that replay can never reject our own output.
    if (!recordSchema.safeParse(record).success) {
      throw new LedgerError("invalid", "Invalid ledger record.");
    }
    try {
      // appendFile loops until the whole line is written (O_APPEND positions it).
      await this.#handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
      await this.#handle.sync();
    } catch {
      this.#fault = "journal-write-failed";
      throw new LedgerError("faulted", "Credit ledger write failed; the ledger is faulted.");
    }
    this.#seq = record.seq;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new LedgerError("closed", "Credit ledger is closed."));
    const result = this.#tail.then(() => {
      if (this.#fault) throw new LedgerError("faulted", "Credit ledger is faulted.");
      return operation();
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  /** Atomically check all four counters and durably reserve before any dispatch. */
  reserve(input: ReserveInput): Promise<void> {
    return this.#serialize(async () => {
      const invalid = () => new LedgerError("invalid", "Invalid reservation request.");
      if (!reservationId.safeParse(input.id).success || this.#known.has(input.id)) throw invalid();
      if (!isPuzzleId(input.puzzle) || !identifier.safeParse(input.operation).success) {
        throw invalid();
      }
      if (!isCredits(input.amount) || input.amount <= 0n) throw invalid();
      if (this.#pendingOverruns.size > 0) {
        throw new LedgerError("denied", "An unacknowledged credit overrun blocks admission.");
      }
      const subscription = this.#config.subscriptions.find((s) => s.id === input.subscription);
      const pool = this.#config.creditPools.find((p) => p.id === subscription?.creditPool);
      const subscriptionLimits = this.#subscriptionLimits.get(input.subscription);
      const poolLimits = pool && this.#poolLimits.get(pool.id);
      if (!subscription || !pool || !subscriptionLimits || !poolLimits) throw invalid();
      const keys = counterKeys(subscription.id, pool.id, input.puzzle);
      const limits = [
        subscriptionLimits.event,
        subscriptionLimits.perPuzzle,
        poolLimits.event,
        poolLimits.perPuzzle,
      ];
      for (const [index, key] of keys.entries()) {
        const used = addCredits(get(this.#spent, key), get(this.#reserved, key));
        if (used > (limits[index] ?? ZERO_CREDITS) - input.amount) {
          throw new LedgerError("denied", "Insufficient credits for the reservation.");
        }
      }
      const held: Held = {
        id: input.id,
        subscription: subscription.id,
        pool: pool.id,
        puzzle: input.puzzle,
        amount: input.amount,
        session: this.#session,
        uncertain: undefined,
      };
      try {
        await this.#append({
          type: "reserve",
          id: held.id,
          session: held.session,
          subscription: held.subscription,
          pool: held.pool,
          provider: subscription.provider,
          unit: pool.unit,
          puzzle: held.puzzle,
          amount: formatCredits(held.amount),
          operation: input.operation,
        });
      } catch (error) {
        // A failed write may still be on disk: count it as held (fail closed).
        if (error instanceof LedgerError && error.code === "faulted") this.#applyReserve(held);
        throw error;
      }
      this.#applyReserve(held);
    });
  }

  /**
   * Record an authoritative actual charge. Actual may exceed the reservation (the
   * bound was wrong): it is recorded truthfully and blocks admission until acknowledged.
   */
  settle(id: string, actual: Credits, receipt: string): Promise<void> {
    return this.#serialize(async () => {
      const held = this.#held.get(id);
      if (!held || !isCredits(actual) || !evidence.safeParse(receipt).success) {
        throw new LedgerError("invalid", "Invalid settlement.");
      }
      await this.#append({ type: "settle", id, actual: formatCredits(actual), evidence: receipt });
      this.#applySettle(held, actual);
    });
  }

  /** Annotate a held reservation whose outcome is unknown. It stays held. */
  markUncertain(id: string, reason: string): Promise<void> {
    return this.#serialize(async () => {
      const held = this.#held.get(id);
      if (!held || !identifier.safeParse(reason).success) {
        throw new LedgerError("invalid", "Invalid uncertainty record.");
      }
      await this.#append({ type: "uncertain", id, reason });
      held.uncertain = reason;
    });
  }

  /** Operator acknowledgement that an overrun was investigated. Spent stays recorded. */
  acknowledgeOverrun(id: string, note: string): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#pendingOverruns.has(id) || !identifier.safeParse(note).success) {
        throw new LedgerError("invalid", "No such pending overrun.");
      }
      await this.#append({ type: "acknowledge", id, note });
      this.#pendingOverruns.delete(id);
    });
  }

  status(puzzles: readonly PuzzleId[] = []): LedgerStatus {
    const periods: ("event" | PuzzleId)[] = [
      "event",
      ...[...new Set([...this.#puzzles, ...puzzles.filter(isPuzzleId)])].sort(),
    ];
    const counters: CounterStatus[] = [];
    const add = (scope: "subscription" | "pool", id: string, unit: string, limits: Limits) => {
      for (const period of periods) {
        const key = `${scope}/${id}/${period}`;
        const limit = period === "event" ? limits.event : limits.perPuzzle;
        const spent = get(this.#spent, key);
        const reserved = get(this.#reserved, key);
        const used = addCredits(spent, reserved);
        const exceeded = used > limit;
        counters.push({
          scope,
          id,
          unit,
          period,
          limit,
          spent,
          reserved,
          remaining: exceeded ? ZERO_CREDITS : subtractCredits(limit, used),
          exceeded,
        });
      }
    };
    for (const subscription of this.#config.subscriptions) {
      const unit = this.#config.creditPools.find((p) => p.id === subscription.creditPool)?.unit;
      const limits = this.#subscriptionLimits.get(subscription.id);
      if (unit && limits) add("subscription", subscription.id, unit, limits);
    }
    for (const pool of this.#config.creditPools) {
      const limits = this.#poolLimits.get(pool.id);
      if (limits) add("pool", pool.id, pool.unit, limits);
    }
    return {
      eventYear: this.#config.event.year,
      fault: this.#fault,
      pendingOverruns: [...this.#pendingOverruns],
      held: [...this.#held.values()].map((held) => ({
        id: held.id,
        subscription: held.subscription,
        pool: held.pool,
        puzzle: held.puzzle,
        amount: held.amount,
        orphaned: held.session !== this.#session,
        uncertain: held.uncertain,
      })),
      counters,
    };
  }

  /**
   * Rejects new operations immediately; operations queued earlier drain first
   * (they were chained on #tail before close was called), then the journal and
   * lock are released.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    await this.#handle?.close();
    this.#handle = undefined;
    await unlink(join(this.#directory, LOCK));
  }
}
