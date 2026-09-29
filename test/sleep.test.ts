import assert from "node:assert/strict";
import test from "node:test";
import { abortableSleep } from "../src/util/sleep.ts";

test("sleeps longer than Node's timer limit are split into steps", async (t) => {
  const delays: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((fn: () => void, ms: number) => {
    delays.push(ms);
    queueMicrotask(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  await abortableSleep(62 * 24 * 3_600_000);
  assert.ok(delays.length >= 3);
  assert.ok(
    delays.every((ms) => ms <= 2_147_483_647),
    "no delay above 2^31-1 ms",
  );
  assert.equal(
    delays.reduce((a, b) => a + b, 0),
    62 * 24 * 3_600_000,
  );
  delays.length = 0;
  await abortableSleep(10);
  assert.deepEqual(delays, [10]);
});

test("an aborted long sleep rejects", async () => {
  const controller = new AbortController();
  const pending = abortableSleep(30 * 24 * 3_600_000, controller.signal);
  controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
});
