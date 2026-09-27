/**
 * AoC release rules verified from the official About/FAQ (2026-09-27): puzzles
 * unlock at midnight EST (UTC-5), start on December 1, and "puzzles come out
 * every day (ending mid-December)" — the number of days per event varies, so it is
 * never hardcoded here. Callers choose days explicitly or learn them from the site.
 */

const RELEASE_UTC_HOUR = 5;

export function releaseTime(year: number, day: number): Date {
  if (!Number.isInteger(year) || year < 2015 || year > 9999) throw new Error("Invalid year.");
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("Invalid day.");
  return new Date(Date.UTC(year, 11, day, RELEASE_UTC_HOUR, 0, 0, 0));
}

export function isReleased(year: number, day: number, now: Date): boolean {
  return now.getTime() >= releaseTime(year, day).getTime();
}

export interface WaitOptions {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Wait this long past the nominal release to absorb clock skew. */
  readonly marginMs?: number;
  /** Longest single sleep, so clock jumps are noticed promptly. */
  readonly maxSleepMs?: number;
  readonly signal?: AbortSignal;
}

/** Sleep (never poll the site) until the release time plus margin. */
export async function waitForRelease(year: number, day: number, options: WaitOptions) {
  const target = releaseTime(year, day).getTime() + (options.marginMs ?? 3_000);
  const maxSleep = options.maxSleepMs ?? 60_000;
  for (;;) {
    options.signal?.throwIfAborted();
    const remaining = target - options.now();
    if (remaining <= 0) return;
    await options.sleep(Math.min(remaining, maxSleep), options.signal);
  }
}

/**
 * Delays between puzzle-page retries while a just-released puzzle still reports
 * "not available". Short at first to tolerate skew, then the 15-minute spacing
 * AoC asks for automated requests; bounded so a wrong clock cannot loop forever.
 */
export const UNLOCK_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 900_000];
