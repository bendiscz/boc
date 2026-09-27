import { appendFile } from "node:fs/promises";
import { isReleased, UNLOCK_RETRY_DELAYS_MS, waitForRelease } from "./aoc/calendar.ts";
import { type AocClient, AocError, createAocClient } from "./aoc/client.ts";
import { AocService } from "./aoc/service.ts";
import { createLedgerAdmission } from "./budget/admission.ts";
import { CreditLedger, type LedgerStatus } from "./budget/ledger.ts";
import { selectSubscription } from "./budget/select.ts";
import type { BocConfig } from "./config.ts";
import {
  type AdapterFactory,
  PRODUCTION_ADAPTERS,
  type ProviderAdapter,
} from "./providers/adapter.ts";
import { createDockerExecutor, type Executor } from "./sandbox/executor.ts";
import { type PartOutcome, solvePuzzle } from "./solver/run.ts";
import { type PuzzleId, puzzleId } from "./state/ids.ts";
import { layout } from "./state/layout.ts";
import { type RunState, RunStore } from "./state/run-state.ts";
import { writeViews } from "./state/summary.ts";
import { abortableSleep } from "./util/sleep.ts";

/**
 * Top-level run: preflight (fail closed before any network or ledger access),
 * then for each day wait for release by sleeping, solve both parts, and refresh
 * the private views. Only the trusted orchestrator touches AoC and providers.
 */

export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}

export interface RunOptions {
  readonly config: BocConfig;
  readonly version: string;
  /** Explicit days; default: day 1 upward until a released day is unavailable. */
  readonly days?: readonly number[];
  readonly adapters?: Readonly<Partial<Record<string, AdapterFactory>>>;
  readonly aocClient?: AocClient;
  readonly executor?: Executor;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly onEvent?: (message: string) => void;
  /** Called after every event with journal-backed state, e.g. for the terminal view. */
  readonly onProgress?: (progress: Progress) => void;
  readonly maxAttemptsPerPart?: number;
  readonly maxTurnsPerAttempt?: number;
  /** Calibration runs: refuse any day that is not already released (never wait). */
  readonly pastOnly?: boolean;
}

export interface Progress {
  readonly state: RunState;
  readonly ledger: LedgerStatus;
  readonly current: PuzzleId | undefined;
}

export interface DayResult {
  readonly puzzle: PuzzleId;
  readonly part1: PartOutcome | "not-released";
  readonly part2: PartOutcome | undefined;
}

export async function runEvent(options: RunOptions): Promise<DayResult[]> {
  const { config } = options;
  let log = options.onEvent ?? (() => {});
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const year = config.event.year;

  const days = options.days ? [...options.days] : undefined;
  if (options.pastOnly && (!days || days.some((day) => !isReleased(year, day, now())))) {
    throw new AppError("Calibration runs are limited to already released days.");
  }
  // Preflight, fail closed: providers first, before any AoC or ledger access.
  const factories = options.adapters ?? PRODUCTION_ADAPTERS;
  const adapters = new Map<string, ProviderAdapter>();
  for (const subscription of config.subscriptions) {
    // Best-effort limits need an estimate (D016); without one the subscription cannot run.
    if (!subscription.estimate) {
      log(`subscription ${subscription.id}: no estimate configured; not used`);
      continue;
    }
    const adapter = await factories[subscription.provider]?.(subscription);
    if (adapter) {
      if (adapter.model.id !== subscription.model) {
        throw new AppError(`Adapter model does not match subscription ${subscription.id}.`);
      }
      adapters.set(subscription.id, adapter);
    }
  }
  if (adapters.size === 0) {
    throw new AppError(
      "No eligible provider adapter: no calibrated adapter exists for any configured subscription (see docs/FEASIBILITY.md).",
    );
  }
  for (const pool of config.creditPools) {
    if (pool.providerCap !== "configured") {
      log(
        `warning: pool ${pool.id} has no provider-side spending cap; BoC limits are best effort and can be exceeded`,
      );
    }
  }
  if (!options.executor && !config.sandbox) {
    throw new AppError("Configure sandbox.image (see docs/SANDBOX.md).");
  }
  if (days && days.length === 0) throw new AppError("No days selected.");
  if (days?.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) {
    throw new AppError("Days must be from 1 to 31.");
  }

  const paths = layout(config.storageDir, year);
  const clock = { now };
  let logWrites: Promise<void> = Promise.resolve();
  const ledger = await CreditLedger.open({ directory: paths.ledger, config, now: clock.now });
  let store: RunStore | undefined;
  try {
    store = await RunStore.open({ directory: paths.runs, eventYear: year, now: clock.now });
    const opened = store;
    let current: PuzzleId | undefined;
    const notify = options.onEvent ?? (() => {});
    log = (message: string) => {
      notify(message);
      const line = `${now().toISOString()} ${message}\n`;
      // Private, append-only run log; ordered by chaining, never blocking the run.
      logWrites = logWrites
        .then(() => appendFile(paths.eventLog, line, { mode: 0o600 }))
        .catch(() => {});
      options.onProgress?.({
        state: opened.state,
        ledger: ledger.status(current ? [current] : []),
        current,
      });
    };
    const setCurrent = (puzzle: PuzzleId) => {
      current = puzzle;
    };
    const client =
      options.aocClient ??
      createAocClient({
        cookieFile: config.aoc.sessionCookieFile,
        contact: config.aoc.contact,
        version: options.version,
      });
    await client.prepare();
    const aoc = new AocService({ client, store, paths, year, now });
    const executor =
      options.executor ?? createDockerExecutor({ image: config.sandbox?.image ?? "" });
    const results: DayResult[] = [];

    let day: number | undefined = days ? days.shift() : 1;
    while (day !== undefined) {
      options.signal?.throwIfAborted();
      const puzzle = puzzleId(day);
      setCurrent(puzzle);
      if (!isReleased(year, day, now())) {
        log(`${puzzle}: waiting for release`);
        await waitForRelease(year, day, {
          now: () => now().getTime(),
          sleep,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      const available = await fetchWhenUnlocked(aoc, store, puzzle, sleep, log, options.signal);
      if (!available) {
        log(`${puzzle}: not available`);
        results.push({ puzzle, part1: "not-released", part2: undefined });
        if (!days) break; // Default mode: the event has no further puzzles.
      } else {
        const bound = store;
        const outcome = await solvePuzzle({
          year,
          puzzle,
          store: bound,
          aoc,
          paths,
          executor,
          binding: () => {
            const chosen = selectSubscription({
              config,
              ledger: ledger.status([puzzle]),
              puzzle,
              eligible: (id) => adapters.has(id),
              minimum: (id) => adapters.get(id)?.minimumAttemptCredits,
            });
            const adapter = chosen === undefined ? undefined : adapters.get(chosen);
            if (!chosen || !adapter) return undefined;
            return {
              subscription: chosen,
              model: adapter.model,
              transport: adapter.transport,
              ...(adapter.outputCap ? { outputCap: adapter.outputCap } : {}),
              admission: createLedgerAdmission({
                ledger,
                subscription: chosen,
                model: adapter.model.id,
                puzzle,
                meter: adapter.meter,
                operation: "solve",
              }),
            };
          },
          now,
          sleep,
          ...(options.signal ? { signal: options.signal } : {}),
          onEvent: log,
          ...(options.maxAttemptsPerPart ? { maxAttemptsPerPart: options.maxAttemptsPerPart } : {}),
          ...(options.maxTurnsPerAttempt ? { maxTurnsPerAttempt: options.maxTurnsPerAttempt } : {}),
        });
        results.push({ puzzle, ...outcome });
        log(`${puzzle}: part 1 ${outcome.part1}, part 2 ${outcome.part2 ?? "-"}`);
        if (outcome.part1 === "provider-fault" || outcome.part2 === "provider-fault") {
          // A fault means an unreconciled held reservation and an adapter whose accounting
          // just failed; stop the whole run rather than fail over to another subscription.
          log("stopping: provider outcome uncertain; reconcile held reservations first");
          await writeViews(paths, bound.state, ledger.status());
          break;
        }
      }
      await writeViews(paths, store.state, ledger.status());
      day = days ? days.shift() : day < 31 ? day + 1 : undefined;
    }
    return results;
  } finally {
    await logWrites;
    await store?.close().catch(() => {});
    await ledger.close().catch(() => {});
  }
}

/** Fetch part 1 at/after release with a few bounded retries (clock skew), never polling. */
async function fetchWhenUnlocked(
  aoc: AocService,
  store: RunStore,
  puzzle: PuzzleId,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  log: (message: string) => void,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (store.state.puzzles[puzzle]?.parts[1].statementSha256) return true;
  for (const delay of [...UNLOCK_RETRY_DELAYS_MS, undefined]) {
    try {
      await aoc.statement(puzzle, 1);
      return true;
    } catch (error) {
      if (!(error instanceof AocError) || error.code !== "not-available") throw error;
      if (delay === undefined) return false;
      log(`${puzzle}: not unlocked yet; retrying in ${delay / 1000} s`);
      await sleep(delay, signal);
    }
  }
  return false;
}
