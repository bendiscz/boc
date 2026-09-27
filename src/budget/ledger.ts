import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { BocConfig } from "../config.ts";
import { isPuzzleId, type PuzzleId } from "../state/ids.ts";
import { Journal, JournalError } from "../state/journal.ts";
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
    /** How the charge was established (D016); absent in older records means "provider". */
    source: z.enum(["provider", "derived", "estimated", "operator"]).optional(),
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

export type ChargeSource = "provider" | "derived" | "estimated" | "operator";

export interface PoolOvershoot {
  readonly pool: string;
  readonly excess: Credits;
  readonly tolerance: Credits;
  readonly blocking: boolean;
}

export interface LedgerStatus {
  readonly eventYear: number;
  readonly fault: string | undefined;
  /** Unacknowledged overruns (actual above the reserved estimate). */
  readonly pendingOverruns: readonly string[];
  /** Per-pool unacknowledged excess versus tolerance; blocking pools deny admission. */
  readonly overshoot: readonly PoolOvershoot[];
  readonly held: readonly HeldReservation[];
  readonly counters: readonly CounterStatus[];
}

export interface SubscriptionReport {
  readonly subscription: string;
  readonly calls: number;
  readonly settled: number;
  readonly held: number;
  /** Held reservations annotated as uncertain (unknown outcome; reconcile first). */
  readonly uncertain: number;
  /** Sum of reserved estimates for settled calls. */
  readonly estimated: Credits;
  readonly charged: Credits;
  readonly bySource: Readonly<Partial<Record<ChargeSource, Credits>>>;
  /** Largest actual/estimate ratio among settled calls. */
  readonly maxRatio: number | undefined;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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

function toLedgerError(error: unknown): LedgerError {
  if (error instanceof LedgerError) return error;
  if (error instanceof JournalError) {
    return new LedgerError(error.code, `Credit ledger: ${error.message}`);
  }
  return new LedgerError("corrupt", "Cannot use the credit ledger.");
}

export function ledgerDirectory(config: BocConfig): string {
  return join(config.storageDir, "ledger", String(config.event.year));
}

export class CreditLedger {
  readonly #config: BocConfig;
  readonly #session = randomUUID();
  /** Session whose holds are "live"; for read-only inspection, the latest opener. */
  #liveSession: string = this.#session;
  readonly #subscriptionLimits = new Map<string, Limits>();
  readonly #poolLimits = new Map<string, Limits>();
  readonly #spent = new Map<string, Credits>();
  readonly #reserved = new Map<string, Credits>();
  readonly #held = new Map<string, Held>();
  readonly #known = new Set<string>();
  /** Unacknowledged overruns: reservation id → pool and excess above the estimate. */
  readonly #pendingOverruns = new Map<string, { pool: string; excess: Credits }>();
  readonly #tolerance = new Map<string, Credits>();
  readonly #puzzles = new Set<PuzzleId>();
  #journal: Journal<LedgerRecord> | undefined;

  private constructor(options: LedgerOptions) {
    this.#config = options.config;
    const limits = (value: { event: string; perPuzzle: string }): Limits => ({
      event: parseCredits(value.event),
      perPuzzle: parseCredits(value.perPuzzle),
    });
    for (const pool of options.config.creditPools) {
      this.#poolLimits.set(pool.id, limits(pool.limits));
      // Default tolerance: 5% of the pool's event limit (D016).
      this.#tolerance.set(
        pool.id,
        pool.overshootTolerance !== undefined
          ? parseCredits(pool.overshootTolerance)
          : (((parseCredits(pool.limits.event) * 5n) / 100n) as Credits),
      );
    }
    for (const subscription of options.config.subscriptions) {
      this.#subscriptionLimits.set(subscription.id, limits(subscription.limits));
    }
  }

  static async open(options: LedgerOptions): Promise<CreditLedger> {
    const ledger = new CreditLedger(options);
    let opened: { journal: Journal<LedgerRecord>; records: LedgerRecord[] };
    try {
      opened = await Journal.open({
        directory: options.directory,
        schema: recordSchema,
        ...(options.now ? { now: options.now } : {}),
      });
    } catch (error) {
      throw toLedgerError(error);
    }
    ledger.#journal = opened.journal;
    try {
      for (const [index, record] of opened.records.entries()) {
        if ((index === 0) !== (record.type === "create")) {
          throw new LedgerError("corrupt", "Credit ledger journal is corrupt.");
        }
        ledger.#replay(record);
      }
      if (opened.journal.empty) {
        await opened.journal.append({
          type: "create",
          version: LEDGER_VERSION,
          eventYear: options.config.event.year,
          ledger: randomUUID(),
        });
      }
      await opened.journal.append({ type: "open", session: ledger.#session });
      ledger.#liveSession = ledger.#session;
    } catch (error) {
      await opened.journal.close().catch(() => {});
      throw toLedgerError(error);
    }
    return ledger;
  }

  /**
   * Read-only status without taking the lock (safe while BoC runs). Holds made by
   * the most recent opener are reported as live, earlier ones as orphaned.
   */
  static async inspect(options: Omit<LedgerOptions, "now">): Promise<LedgerStatus> {
    const ledger = new CreditLedger(options);
    try {
      const records = await Journal.read({ directory: options.directory, schema: recordSchema });
      for (const [index, record] of records.entries()) {
        if ((index === 0) !== (record.type === "create")) {
          throw new LedgerError("corrupt", "Credit ledger journal is corrupt.");
        }
        ledger.#replay(record);
      }
    } catch (error) {
      throw toLedgerError(error);
    }
    return ledger.status();
  }

  /**
   * Read-only calibration summary per subscription (D016): how estimates compare
   * with recorded charges, by charge source. For comparison with provider billing.
   */
  static async report(options: Omit<LedgerOptions, "now">): Promise<SubscriptionReport[]> {
    const records = await Journal.read({
      directory: options.directory,
      schema: recordSchema,
    }).catch((error: unknown) => {
      throw toLedgerError(error);
    });
    const reserves = new Map<
      string,
      { subscription: string; amount: Credits; uncertain: boolean }
    >();
    const reports = new Map<string, Mutable<SubscriptionReport>>();
    const entry = (subscription: string) => {
      let report = reports.get(subscription);
      if (!report) {
        report = {
          subscription,
          calls: 0,
          settled: 0,
          held: 0,
          uncertain: 0,
          estimated: ZERO_CREDITS,
          charged: ZERO_CREDITS,
          bySource: {},
          maxRatio: undefined,
        };
        reports.set(subscription, report);
      }
      return report;
    };
    for (const record of records) {
      if (record.type === "reserve") {
        reserves.set(record.id, {
          subscription: record.subscription,
          amount: parseCredits(record.amount),
          uncertain: false,
        });
        const report = entry(record.subscription);
        report.calls++;
        report.held++;
      } else if (record.type === "uncertain") {
        const reserve = reserves.get(record.id);
        if (reserve && !reserve.uncertain) {
          reserve.uncertain = true;
          entry(reserve.subscription).uncertain++;
        }
      } else if (record.type === "settle") {
        const reserve = reserves.get(record.id);
        if (!reserve) continue;
        const report = entry(reserve.subscription);
        if (reserve.uncertain) report.uncertain--;
        const actual = parseCredits(record.actual);
        const source = record.source ?? "provider";
        report.settled++;
        report.held--;
        report.estimated = addCredits(report.estimated, reserve.amount);
        report.charged = addCredits(report.charged, actual);
        report.bySource = {
          ...report.bySource,
          [source]: addCredits(report.bySource[source] ?? ZERO_CREDITS, actual),
        };
        // Ratio actual/estimate in millionths, for "no call above its estimate × safety".
        const ratio =
          reserve.amount > 0n ? Number((actual * 1_000_000n) / reserve.amount) / 1e6 : 0;
        if (report.maxRatio === undefined || ratio > report.maxRatio) report.maxRatio = ratio;
      }
    }
    return [...reports.values()].sort((a, b) => a.subscription.localeCompare(b.subscription));
  }

  /** See `Journal.breakStaleLock`. */
  static async breakStaleLock(directory: string): Promise<void> {
    try {
      await Journal.breakStaleLock(directory);
    } catch (error) {
      throw toLedgerError(error);
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
        this.#liveSession = record.session;
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
    if (actual > held.amount) {
      this.#pendingOverruns.set(held.id, {
        pool: held.pool,
        excess: subtractCredits(actual, held.amount),
      });
    }
  }

  #append(body: RecordBody): Promise<LedgerRecord> {
    if (!this.#journal) throw new LedgerError("closed", "Credit ledger is closed.");
    return this.#journal.append(body);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#journal)
      return Promise.reject(new LedgerError("closed", "Credit ledger is closed."));
    return this.#journal.run(operation).catch((error: unknown) => {
      throw toLedgerError(error);
    });
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
      const subscription = this.#config.subscriptions.find((s) => s.id === input.subscription);
      const pool = this.#config.creditPools.find((p) => p.id === subscription?.creditPool);
      if (pool && this.#poolExcess(pool.id) > (this.#tolerance.get(pool.id) ?? ZERO_CREDITS)) {
        throw new LedgerError("denied", "Unacknowledged overshoot exceeds the pool tolerance.");
      }
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
        if (error instanceof JournalError && error.code === "faulted") this.#applyReserve(held);
        throw error;
      }
      this.#applyReserve(held);
    });
  }

  /**
   * Record the actual charge and how it was established. Actual may exceed the
   * reserved estimate: it is recorded truthfully, and admission to that pool blocks
   * once its unacknowledged excess exceeds the pool's tolerance (best effort, D016).
   */
  settle(
    id: string,
    actual: Credits,
    receipt: string,
    source: ChargeSource = "provider",
  ): Promise<void> {
    return this.#serialize(async () => {
      const held = this.#held.get(id);
      if (!held || !isCredits(actual) || !evidence.safeParse(receipt).success) {
        throw new LedgerError("invalid", "Invalid settlement.");
      }
      await this.#append({
        type: "settle",
        id,
        actual: formatCredits(actual),
        evidence: receipt,
        source,
      });
      this.#applySettle(held, actual);
    });
  }

  #poolExcess(pool: string): Credits {
    let total = ZERO_CREDITS;
    for (const overrun of this.#pendingOverruns.values()) {
      if (overrun.pool === pool) total = addCredits(total, overrun.excess);
    }
    return total;
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
      fault: this.#journal?.faulted ? "journal-write-failed" : undefined,
      pendingOverruns: [...this.#pendingOverruns.keys()],
      overshoot: this.#config.creditPools.map((pool) => {
        const excess = this.#poolExcess(pool.id);
        const tolerance = this.#tolerance.get(pool.id) ?? ZERO_CREDITS;
        return { pool: pool.id, excess, tolerance, blocking: excess > tolerance };
      }),
      held: [...this.#held.values()].map((held) => ({
        id: held.id,
        subscription: held.subscription,
        pool: held.pool,
        puzzle: held.puzzle,
        amount: held.amount,
        orphaned: held.session !== this.#liveSession,
        uncertain: held.uncertain,
      })),
      counters,
    };
  }

  /** Drains operations queued before the call, then releases the journal and lock. */
  async close(): Promise<void> {
    await this.#journal?.close();
  }
}
