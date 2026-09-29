/** Longest delay Node's timers honour; a larger one fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Timer sleep that rejects on abort and never leaks abort listeners. Delays above
 * Node's timer limit are slept in several steps (callers that wait for a wall-clock
 * time should still use `sleepUntil`, which also follows clock changes).
 */
export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  let remaining = ms;
  do {
    const step = Math.min(Math.max(remaining, 0), MAX_TIMER_MS);
    await timerSleep(step, signal);
    remaining -= step;
  } while (remaining > 0);
}

function timerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
