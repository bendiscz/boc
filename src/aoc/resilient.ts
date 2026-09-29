import { stat } from "node:fs/promises";
import { UNLOCK_RETRY_DELAYS_MS } from "./calendar.ts";
import { type AocClient, AocError } from "./client.ts";

/**
 * Page reads that survive AoC trouble within a deadline (D025). Answer
 * submissions pass through unchanged: their unknown outcomes are reconciled,
 * never retried.
 *
 * - A transient failure (5xx, network, timeout) is retried after 15 s, 30 s,
 *   60 s, then every 15 minutes, as for a just-released puzzle (AOC.md).
 * - A rejected session (the first 500 is checked with `checkSession`, which
 *   probes a public page) waits for the operator to replace the cookie file. The
 *   file is watched locally every minute; the session is rechecked when it
 *   changes, and at most every 15 minutes otherwise.
 * - Past the deadline, the original error is thrown.
 */

export const AOC_READ_RETRY_DELAYS_MS = UNLOCK_RETRY_DELAYS_MS;
export const SESSION_RECHECK_MS = 15 * 60_000;
export const COOKIE_POLL_MS = 60_000;

export interface ResilientAocOptions {
  readonly client: AocClient;
  readonly cookieFile: string;
  /** Epoch ms after which failures are thrown; read on every failure. */
  readonly deadline: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly log: (message: string) => void;
  /** Called once per wait for a replaced cookie (operator alert). */
  readonly onSessionRejected?: () => void;
}

export function resilientAocClient(options: ResilientAocOptions): AocClient {
  const { client, now, sleep, log } = options;
  const mtime = async () => {
    try {
      return (await stat(options.cookieFile)).mtimeMs;
    } catch {
      return undefined;
    }
  };

  const waitForSession = async (error: AocError): Promise<void> => {
    log("AoC rejected the session: replace the cookie file; BoC picks it up within a minute");
    options.onSessionRejected?.();
    let seen = await mtime();
    let checked = now();
    for (;;) {
      if (now() + COOKIE_POLL_MS > options.deadline()) throw error;
      await sleep(COOKIE_POLL_MS, options.signal);
      const current = await mtime();
      if (current === seen && now() - checked < SESSION_RECHECK_MS) continue;
      seen = current;
      checked = now();
      if ((await client.checkSession?.()) === "ok") {
        log("AoC session accepted again");
        return;
      }
    }
  };

  const read = async (what: string, fn: () => Promise<string>): Promise<string> => {
    let failures = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof AocError)) throw error;
        const transient =
          (error.code === "http" && (error.status ?? 0) >= 500) ||
          error.code === "network" ||
          error.code === "timeout";
        if (!transient && error.code !== "auth") throw error;
        const rejected =
          error.code === "auth" ||
          (failures === 0 &&
            error.status === 500 &&
            (await client.checkSession?.()) === "logged-out");
        if (rejected) {
          await waitForSession(error);
          failures = 0;
          continue;
        }
        const delay =
          AOC_READ_RETRY_DELAYS_MS[Math.min(failures, AOC_READ_RETRY_DELAYS_MS.length - 1)] ?? 0;
        failures++;
        if (now() + delay > options.deadline()) throw error;
        log(
          `AoC ${what} failed (${error.status ? `HTTP ${error.status}` : error.code}); retrying in ${delay / 1000} s`,
        );
        await sleep(delay, options.signal);
      }
    }
  };

  return Object.freeze({
    prepare: () => client.prepare(),
    fetchPuzzle: (year: number, day: number) =>
      read("puzzle page", () => client.fetchPuzzle(year, day)),
    fetchInput: (year: number, day: number) => read("input", () => client.fetchInput(year, day)),
    submitAnswer: (year: number, day: number, part: 1 | 2, answer: string) =>
      client.submitAnswer(year, day, part, answer),
    ...(client.checkSession
      ? { checkSession: () => client.checkSession?.() ?? Promise.resolve("unknown" as const) }
      : {}),
  });
}
