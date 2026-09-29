import { appendFile } from "node:fs/promises";
import { type Alert, createNotifier, type Notifier } from "./alerts/notifier.ts";
import {
  isReleased,
  releaseTime,
  sleepUntil,
  UNLOCK_RETRY_DELAYS_MS,
  waitForRelease,
} from "./aoc/calendar.ts";
import { type AocClient, AocError, createAocClient, DEFAULT_RATE_CAP } from "./aoc/client.ts";
import { resilientAocClient } from "./aoc/resilient.ts";
import { AocService } from "./aoc/service.ts";
import { createLedgerAdmission } from "./budget/admission.ts";
import { formatCredits } from "./budget/credits.ts";
import { CreditLedger, LedgerError, type LedgerStatus } from "./budget/ledger.ts";
import { selectSubscription } from "./budget/select.ts";
import type { BocConfig } from "./config.ts";
import {
  type AdapterFactory,
  PRODUCTION_ADAPTERS,
  type ProviderAdapter,
} from "./providers/adapter.ts";
import { AdapterError } from "./providers/github-copilot.ts";
import { createDockerExecutor, type Executor } from "./sandbox/executor.ts";
import { type PartOutcome, solvePuzzle } from "./solver/run.ts";
import { type PuzzleId, puzzleId } from "./state/ids.ts";
import { JournalError } from "./state/journal.ts";
import { layout } from "./state/layout.ts";
import { type RunState, RunStore, StateError } from "./state/run-state.ts";
import { writeViews } from "./state/summary.ts";
import { PrivateFileError } from "./util/private-file.ts";
import { abortableSleep } from "./util/sleep.ts";

/** Readiness checks (credentials and AoC session) this long before each release. */
const PRE_RELEASE_CHECK_MS = 30 * 60_000;
/** After a failed pre-release check, check again this long before the release. */
const PRE_RELEASE_RECHECK_MS = 5 * 60_000;
/**
 * During a long wait (for example weeks before the event), readiness is checked
 * this often: refresh tokens stay in use, and an expired credential or AoC cookie
 * is reported weeks early instead of at T−30 (operator decision, D029).
 */
export const DAILY_CHECK_MS = 24 * 3_600_000;

/** How long a usage-limited subscription is skipped when the provider gives no reset time. */
const DEFAULT_REFUSAL_MS = 60 * 60_000;
/** Consecutive outages of one subscription skip it this long (the last value repeats). */
export const OUTAGE_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** A credential check that could not reach the provider is retried this soon. */
export const UNREACHABLE_RECHECK_MS = 60_000;
/** While a part waits, rejected credentials are rechecked this often (boc login repairs them). */
export const CREDENTIAL_RECHECK_MS = 5 * 60_000;
/**
 * A part keeps waiting for a usable subscription until this long after its puzzle's
 * release, or after the day's solving began if later (past days). Operator decision.
 */
export const PROVIDER_RETRY_WINDOW_MS = 6 * 3_600_000;

const BRAKE_NOTE = `at most ${DEFAULT_RATE_CAP.max} requests per ${DEFAULT_RATE_CAP.windowMs / 60_000} minutes`;

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
  /** Waits for providers to recover; default `sleep`. Replay passes a real sleep. */
  readonly providerSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly onEvent?: (message: string) => void;
  /** Called after every event with journal-backed state, e.g. for the terminal view. */
  readonly onProgress?: (progress: Progress) => void;
  readonly maxAttemptsPerPart?: number;
  readonly maxTurnsPerAttempt?: number;
  /** Calibration runs: refuse any day that is not already released (never wait). */
  readonly pastOnly?: boolean;
  /** Operator alerts; default: from `config.alerts` (D023). Replay and tests inject their own. */
  readonly notifier?: Notifier;
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
  // Argument errors are shown to whoever ran the command; they need no alert.
  const days = options.days;
  const now = options.now ?? (() => new Date());
  if (days && days.length === 0) throw new AppError("No days selected.");
  if (days?.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) {
    throw new AppError("Days must be from 1 to 31.");
  }
  if (
    options.pastOnly &&
    (!days || days.some((day) => !isReleased(options.config.event.year, day, now())))
  ) {
    throw new AppError("Calibration runs are limited to already released days.");
  }
  let log = options.onEvent ?? (() => {});
  // Alerts fail closed here: a configured but unusable destination is a start error.
  const notifier =
    options.notifier ?? (await createNotifier(options.config.alerts, { log: (m) => log(m) }));
  const alert = (priority: Alert["priority"], title: string, message: string) =>
    notifier.notify({ priority, title: `BoC ${options.config.event.year}: ${title}`, message });
  try {
    return await runEventWith(options, notifier, alert, (next) => {
      log = next;
    });
  } catch (error) {
    if (options.signal?.aborted) {
      alert("low", "stopped by the operator", "State is saved; run again to resume.");
    } else {
      alert("urgent", "stopped with an error", `${safeMessage(error)} State is saved.`);
      notifier.heartbeat(false);
    }
    throw error;
  } finally {
    await notifier.flush();
  }
}

async function runEventWith(
  options: RunOptions,
  notifier: Notifier,
  alert: (priority: Alert["priority"], title: string, message: string) => void,
  setLog: (log: (message: string) => void) => void,
): Promise<DayResult[]> {
  const { config } = options;
  let log = options.onEvent ?? (() => {});
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const year = config.event.year;

  const days = options.days ? [...options.days] : undefined;
  // Preflight, fail closed: providers first, before any AoC or ledger access.
  const factories = options.adapters ?? PRODUCTION_ADAPTERS;
  const adapters = new Map<string, ProviderAdapter>();
  for (const subscription of config.subscriptions) {
    // Best-effort limits need an estimate (D016); without one the subscription cannot run.
    if (!subscription.estimate) {
      log(`subscription ${subscription.id}: no estimate configured; not used`);
      continue;
    }
    let adapter: ProviderAdapter | undefined;
    try {
      adapter = await factories[subscription.provider]?.(subscription);
    } catch (error) {
      // Fixed-message adapter/credential errors are safe to show; others are generic.
      const safe = error instanceof AdapterError || error instanceof PrivateFileError;
      log(
        `subscription ${subscription.id}: ${safe ? error.message : "adapter could not be created"}; not used`,
      );
      continue;
    }
    if (adapter) {
      if (adapter.model.id !== subscription.model) {
        throw new AppError(`Adapter model does not match subscription ${subscription.id}.`);
      }
      adapters.set(subscription.id, adapter);
    }
  }
  if (adapters.size === 0) {
    throw new AppError(
      "No eligible provider adapter: no configured subscription has a calibrated, usable adapter (see the log above and docs/OPERATOR.md).",
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

  const paths = layout(config.storageDir, year);
  const clock = { now };
  let logWrites: Promise<void> = Promise.resolve();
  // A crash (or a reboot) leaves locks behind; an unattended restart must not stall
  // on them. Locks of a running process, or of another host, are left in place.
  for (const [name, remove] of [
    ["ledger", () => CreditLedger.breakStaleLock(paths.ledger)],
    ["run-state", () => RunStore.breakStaleLock(paths.runs)],
  ] as const) {
    try {
      if (await remove()) log(`removed a stale ${name} lock left by a process that is not running`);
    } catch {
      // Opening below reports the lock.
    }
  }
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
    setLog(log); // Alert delivery problems go to the run log too.
    const setCurrent = (puzzle: PuzzleId) => {
      current = puzzle;
    };
    /** Page reads are retried until this time (set per day: the provider retry window). */
    let aocDeadline = 0;
    let sessionAlerted = false;
    const rawClient =
      options.aocClient ??
      createAocClient({
        cookieFile: config.aoc.sessionCookieFile,
        contact: config.aoc.contact,
        version: options.version,
        sleep: (ms) => sleep(ms, options.signal),
        onBrake: (ms) =>
          log(`AoC request brake: waiting ${Math.ceil(ms / 1000)} s (${BRAKE_NOTE})`),
      });
    const client = resilientAocClient({
      client: rawClient,
      cookieFile: config.aoc.sessionCookieFile,
      deadline: () => aocDeadline,
      now: () => now().getTime(),
      sleep: options.providerSleep ?? sleep,
      ...(options.signal ? { signal: options.signal } : {}),
      log: (message) => log(message),
      onSessionRejected: () => {
        if (sessionAlerted) return;
        sessionAlerted = true;
        alert(
          "urgent",
          "AoC session rejected",
          "Replace the cookie file; BoC picks it up within a minute and continues.",
        );
      },
    });
    await client.prepare();
    const aoc = new AocService({ client, store, paths, year, now });
    const executor =
      options.executor ??
      createDockerExecutor({
        image: config.sandbox?.image ?? "",
        // The executor's own cap must not undercut the configured run limit.
        maxTimeoutMs: (config.sandbox?.maxRunSeconds ?? 60) * 1_000,
      });
    // Containers of a crashed run would otherwise keep their memory and CPU.
    await executor.cleanup?.().catch(() => {});
    const results: DayResult[] = [];

    /** One alert per finished day: timing, attempts, credits; never answers. */
    const alertDay = (
      puzzle: PuzzleId,
      day: number,
      part1: PartOutcome,
      part2: PartOutcome | undefined,
    ) => {
      const state = store?.state.puzzles[puzzle];
      const since = now().getTime() - releaseTime(year, day).getTime();
      const timing =
        since >= 0 && since < 24 * 3_600_000
          ? ` ${Math.floor(since / 60_000)} min ${Math.floor((since % 60_000) / 1000)} s after release.`
          : "";
      const attempts = ([1, 2] as const)
        .map((p) => {
          const part = state?.parts[p];
          return `part ${p}: ${p === 1 ? part1 : (part2 ?? "-")}, ${(part?.attempts ?? 0) - (part?.refusedAttempts ?? 0)} attempt(s), ${part?.submissions.length ?? 0} submission(s)`;
        })
        .join("; ");
      const status = ledger.status([puzzle]);
      const credits = config.subscriptions
        .map((s) => {
          const counter = status.counters.find(
            (c) => c.scope === "subscription" && c.id === s.id && c.period === puzzle,
          );
          return counter && counter.spent > 0n
            ? `${s.id} ${formatCredits(counter.spent)} ${counter.unit}`
            : undefined;
        })
        .filter((c) => c !== undefined);
      const solved = part1 === "solved" && part2 === "solved";
      const trouble = [part1, part2].some(
        (o) =>
          o === "gave-up" ||
          o === "uncertain" ||
          o === "no-subscription" ||
          o === "provider-unavailable",
      );
      alert(
        trouble ? "high" : "default",
        solved ? `${puzzle} solved` : `${puzzle} finished`,
        `${attempts}.${timing}${credits.length > 0 ? ` Credits: ${credits.join(", ")}.` : ""}`,
      );
    };

    /**
     * Subscriptions that cannot be used now, until when (epoch ms). A usage limit
     * lasts until the announced reset (default 60 min). A rejected credential lasts
     * until a later readiness check passes (e.g. after `boc login`).
     */
    const unavailable = new Map<string, number>();
    /** Subscriptions whose credential the provider rejected (not merely unreachable). */
    const rejected = new Set<string>();
    /** Subscriptions whose last credential check could not reach the provider. */
    const unreachable = new Set<string>();
    /** Consecutive outage refusals per subscription, for the backoff. */
    const outages = new Map<string, number>();
    const credentialOk = async (id: string, when: string): Promise<boolean> => {
      const adapter = adapters.get(id);
      if (!adapter?.checkCredential) return true;
      try {
        await adapter.checkCredential(options.signal);
      } catch (error) {
        options.signal?.throwIfAborted();
        const why = error instanceof AdapterError ? error.message : "credential check failed.";
        if (error instanceof AdapterError && error.failure === "rejected") {
          unavailable.set(id, Number.POSITIVE_INFINITY);
          rejected.add(id);
          log(
            `${when} check FAILED: subscription ${id}: ${why} It is skipped until a check passes.`,
          );
        } else {
          // An outage is not a dead credential: retry soon instead of skipping the day.
          unavailable.set(id, now().getTime() + UNREACHABLE_RECHECK_MS);
          rejected.delete(id);
          unreachable.add(id);
          log(
            `${when} check FAILED: subscription ${id}: ${why} Retrying in ${UNREACHABLE_RECHECK_MS / 60_000} min.`,
          );
        }
        return false;
      }
      // Only a check's own verdict is lifted; a usage limit keeps its reset time.
      if (rejected.delete(id) || unreachable.delete(id)) {
        unavailable.delete(id);
        log(`${when} check: subscription ${id} is usable again`);
      }
      return true;
    };
    /** Credentials (no model call) and the AoC session (one page read). */
    const checkReadiness = async (when: string): Promise<boolean> => {
      const failures: string[] = [];
      for (const id of adapters.keys()) {
        if (!(await credentialOk(id, when))) {
          failures.push(
            rejected.has(id)
              ? `Subscription ${id}: credential rejected; run boc login.`
              : `Subscription ${id}: provider unreachable; BoC retries automatically.`,
          );
        }
      }
      if (client.checkSession) {
        const session = await client.checkSession();
        if (session === "logged-out") {
          failures.push("The AoC session is not accepted; replace the cookie file.");
          log(`${when} check FAILED: the AoC session is not accepted; replace the cookie file.`);
        } else if (session === "unknown") {
          log(`${when} check: the AoC session could not be verified`);
        }
      }
      if (failures.length === 0) {
        log(`${when} check passed`);
        notifier.heartbeat(true);
        return true;
      }
      notifier.heartbeat(false);
      const usable = [...adapters.keys()].filter((id) => !unavailable.has(id));
      alert(
        "urgent",
        `${when} check failed`,
        `${failures.join("\n")}\n${usable.length > 0 ? `Still usable: ${usable.join(", ")}.` : "No subscription is usable."}`,
      );
      return false;
    };
    await checkReadiness("start");
    let lastCheck = now().getTime();
    alert(
      "low",
      "started",
      days ? `Days ${days.join(", ")}.` : "Solving released days, then waiting for releases.",
    );

    let day: number | undefined = days ? days.shift() : 1;
    while (day !== undefined) {
      options.signal?.throwIfAborted();
      const puzzle = puzzleId(day);
      setCurrent(puzzle);
      if (!isReleased(year, day, now())) {
        const release = releaseTime(year, day).getTime();
        if (now().getTime() < release - PRE_RELEASE_CHECK_MS) {
          log(`${puzzle}: waiting for the pre-release check`);
          const clockWait = {
            now: () => now().getTime(),
            sleep,
            ...(options.signal ? { signal: options.signal } : {}),
          };
          for (;;) {
            const daily = lastCheck + DAILY_CHECK_MS;
            if (daily >= release - PRE_RELEASE_CHECK_MS) break;
            await sleepUntil(daily, clockWait);
            await checkReadiness("daily");
            lastCheck = now().getTime();
          }
          await sleepUntil(release - PRE_RELEASE_CHECK_MS, clockWait);
          const ok = await checkReadiness(`${puzzle} pre-release`);
          lastCheck = now().getTime();
          if (!ok && now().getTime() < release - PRE_RELEASE_RECHECK_MS) {
            await sleepUntil(release - PRE_RELEASE_RECHECK_MS, clockWait);
            await checkReadiness(`${puzzle} final pre-release`);
          }
        }
        log(`${puzzle}: waiting for release`);
        await waitForRelease(year, day, {
          now: () => now().getTime(),
          sleep,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      // AoC page reads, and the provider waits below, retry within this window.
      const retryDeadline =
        Math.max(releaseTime(year, day).getTime(), now().getTime()) + PROVIDER_RETRY_WINDOW_MS;
      aocDeadline = retryDeadline;
      sessionAlerted = false;
      const available = await fetchWhenUnlocked(aoc, store, puzzle, sleep, log, options.signal);
      if (!available) {
        log(`${puzzle}: not available`);
        results.push({ puzzle, part1: "not-released", part2: undefined });
        if (!days) break; // Default mode: the event has no further puzzles.
      } else {
        const bound = store;
        let waitAlerted = false;
        /** Sleep until a subscription may be usable again, within the retry window. */
        const waitForSubscription = async (): Promise<boolean> => {
          const at = now().getTime();
          const wakes: number[] = [];
          for (const id of adapters.keys()) {
            const until = unavailable.get(id);
            if (until === undefined) continue;
            if (until === Number.POSITIVE_INFINITY) wakes.push(at + CREDENTIAL_RECHECK_MS);
            else if (until > at) wakes.push(until);
          }
          const wake = Math.min(...wakes);
          if (wakes.length === 0 || wake > retryDeadline) {
            if (wakes.length > 0) log(`${puzzle}: provider retry window ends; giving up for now`);
            return false;
          }
          const message = `no subscription is usable now; retrying at ${new Date(wake).toISOString()} (until ${new Date(retryDeadline).toISOString()})`;
          log(`${puzzle}: ${message}`);
          if (!waitAlerted) {
            waitAlerted = true;
            alert("high", `${puzzle} waiting for providers`, `${message}.`);
          }
          await (options.providerSleep ?? sleep)(wake - at, options.signal);
          for (const id of adapters.keys()) {
            if (rejected.has(id)) await credentialOk(id, `${puzzle} retry`);
          }
          return true;
        };
        const outcome = await solvePuzzle({
          year,
          puzzle,
          store: bound,
          aoc,
          paths,
          executor,
          binding: (_part, _attempt, exclude) => {
            const chosen = selectSubscription({
              exclude,
              config,
              ledger: ledger.status([puzzle]),
              puzzle,
              eligible: (id) => adapters.has(id) && !((unavailable.get(id) ?? 0) > now().getTime()),
              minimum: (id) => adapters.get(id)?.minimumAttemptCredits,
            });
            const adapter = chosen === undefined ? undefined : adapters.get(chosen);
            if (!chosen || !adapter) return undefined;
            return {
              subscription: chosen,
              model: adapter.model,
              transport: adapter.transport,
              ...(adapter.outputCap ? { outputCap: adapter.outputCap } : {}),
              ...reasoningOf(config, chosen),
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
          waitForSubscription,
          onProviderAnswered: (id) => {
            outages.delete(id);
          },
          onRefusal: async (refusal) => {
            const count = (outages.get(refusal.subscription) ?? 0) + 1;
            if (refusal.kind === "outage") outages.set(refusal.subscription, count);
            const backoff =
              OUTAGE_BACKOFF_MS[Math.min(count, OUTAGE_BACKOFF_MS.length) - 1] ??
              OUTAGE_BACKOFF_MS[0];
            const until =
              refusal.kind === "credential"
                ? Number.POSITIVE_INFINITY
                : now().getTime() +
                  (refusal.kind === "outage"
                    ? backoff
                    : (refusal.retryAfterMs ?? DEFAULT_REFUSAL_MS));
            unavailable.set(refusal.subscription, until);
            if (refusal.kind === "credential") rejected.add(refusal.subscription);
            // A forced refresh may repair an invalidated access token at once.
            if (refusal.kind === "credential") {
              await credentialOk(refusal.subscription, `${puzzle} refusal`);
            }
            const others = [...adapters.keys()].filter(
              (id) =>
                id !== refusal.subscription && !((unavailable.get(id) ?? 0) > now().getTime()),
            );
            const reason =
              refusal.kind === "credential"
                ? "credential rejected; run boc login"
                : refusal.kind === "outage"
                  ? `network or server error; retrying in ${Math.round(backoff / 1000)} s`
                  : "usage limit";
            const summary = `subscription ${refusal.subscription} unavailable (${reason})${others.length > 0 ? `; failing over to ${others.join(", ")}` : "; no other subscription is available"}`;
            log(summary);
            // A brief outage that clears on the first retry is not worth a page.
            if (refusal.kind !== "outage" || count > 1 || others.length > 0) {
              alert("high", `${puzzle} failover`, summary);
            }
          },
          ...(options.maxAttemptsPerPart ? { maxAttemptsPerPart: options.maxAttemptsPerPart } : {}),
          ...(options.maxTurnsPerAttempt ? { maxTurnsPerAttempt: options.maxTurnsPerAttempt } : {}),
          ...(config.sandbox?.maxRunSeconds ? { maxRunSeconds: config.sandbox.maxRunSeconds } : {}),
        });
        results.push({ puzzle, ...outcome });
        log(`${puzzle}: part 1 ${outcome.part1}, part 2 ${outcome.part2 ?? "-"}`);
        alertDay(puzzle, day, outcome.part1, outcome.part2);
        if (outcome.part1 === "provider-fault" || outcome.part2 === "provider-fault") {
          // A fault means an unreconciled held reservation and an adapter whose accounting
          // just failed; stop the whole run rather than fail over to another subscription.
          log("stopping: provider outcome uncertain; reconcile held reservations first");
          alert(
            "urgent",
            "stopped",
            `${puzzle}: a provider charge is uncertain. Reconcile held reservations (boc status, boc ledger settle), then run again.`,
          );
          notifier.heartbeat(false);
          await writeViews(paths, bound.state, ledger.status());
          break;
        }
        if (outcome.part1 === "provider-unavailable" || outcome.part2 === "provider-unavailable") {
          // The retry window has passed. Later days may still succeed (checks before
          // each release can repair credentials), so the run continues.
          log(
            `${puzzle}: every subscription refused requests until the retry window ended; continuing with the next day`,
          );
          alert(
            "urgent",
            `${puzzle} abandoned`,
            `Every subscription refused requests (credential, usage limit, or outage) until the retry window ended. Resolve it (boc login); a later run can retry this day.`,
          );
          notifier.heartbeat(false);
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

/** The subscription's requested reasoning effort (D031), as an optional binding field. */
function reasoningOf(config: BocConfig, id: string) {
  const reasoning = config.subscriptions.find((s) => s.id === id)?.reasoning;
  return reasoning ? { reasoning } : {};
}

/** Fixed-message error types only; anything else stays generic (it may carry paths). */
function safeMessage(error: unknown): string {
  const safe =
    error instanceof AppError ||
    error instanceof AocError ||
    error instanceof AdapterError ||
    error instanceof LedgerError ||
    error instanceof JournalError ||
    error instanceof StateError ||
    error instanceof PrivateFileError;
  return safe ? (error as Error).message : "Unexpected error; see the terminal.";
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
    // The input is fetched alongside the page, saving a round trip at release (D030).
    // Its failure is ignored here: the attempt fetches it again if needed.
    const input = store.state.puzzles[puzzle]?.inputSha256
      ? undefined
      : aoc.input(puzzle).catch(() => undefined);
    try {
      await aoc.statement(puzzle, 1);
      await input;
      return true;
    } catch (error) {
      await input;
      if (!(error instanceof AocError) || error.code !== "not-available") throw error;
      if (delay === undefined) return false;
      log(`${puzzle}: not unlocked yet; retrying in ${delay / 1000} s`);
      await sleep(delay, signal);
    }
  }
  return false;
}
