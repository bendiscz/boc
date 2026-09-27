import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCredits } from "../src/budget/credits.ts";
import { CreditLedger } from "../src/budget/ledger.ts";
import { parseConfig } from "../src/config.ts";
import { puzzleId } from "../src/state/ids.ts";
import { RunStore } from "../src/state/run-state.ts";
import { renderDashboard } from "../src/ui/dashboard.ts";

test("the dashboard shows phase, subscription, per-pool credits, holds, results, and events", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "boc-dash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = parseConfig({
    version: 1,
    event: { year: 2025 },
    storageDir: dir,
    aoc: { sessionCookieFile: "/synthetic" },
    creditPools: [
      {
        id: "pool",
        provider: "github-copilot",
        unit: "ai-credit",
        limits: { event: "100", perPuzzle: "10" },
      },
    ],
    subscriptions: [
      {
        id: "sub",
        provider: "github-copilot",
        credentialFile: "/s",
        model: "m",
        creditPool: "pool",
        limits: { event: "50", perPuzzle: "10" },
      },
    ],
  });
  const ledger = await CreditLedger.open({ directory: join(dir, "l"), config });
  const store = await RunStore.open({ directory: join(dir, "r"), eventYear: 2025 });
  t.after(async () => {
    await ledger.close().catch(() => {});
    await store.close().catch(() => {});
  });
  const day = puzzleId(1);
  await ledger.reserve({
    id: "r1",
    subscription: "sub",
    puzzle: day,
    amount: parseCredits("2"),
    operation: "t",
  });
  await ledger.reserve({
    id: "r2",
    subscription: "sub",
    puzzle: day,
    amount: parseCredits("1"),
    operation: "t",
  });
  await ledger.settle("r1", parseCredits("1.5"), "receipt:1");
  await store.record({ type: "input-fetched", puzzle: day, sha256: "a".repeat(64) });
  await store.record({ type: "statement-fetched", puzzle: day, part: 1, sha256: "b".repeat(64) });
  await store.record({
    type: "attempt-started",
    puzzle: day,
    part: 1,
    attempt: 1,
    subscription: "sub",
  });
  const text = renderDashboard({
    state: store.state,
    ledger: ledger.status([day]),
    current: day,
    events: ["05:00:03 day-01 part 1: attempt 1 started (sub)"],
    now: new Date("2025-12-01T05:00:04Z"),
  });
  assert.match(text, /Now: day-01 {2}part 1: solving #1 via sub {2}\| {2}part 2: waiting/);
  assert.match(
    text,
    /pool pool \[ai-credit\]\n {4}event: {2}1\.5 spent, 1 held, 97\.5 left of 100/,
  );
  assert.match(text, /day-01: 1\.5 spent, 1 held, 7\.5 left of 10/);
  assert.match(text, /subscription sub \[ai-credit\]/);
  assert.match(text, /held reservations: 1/);
  assert.match(text, /attempt 1 started/);
  const narrow = renderDashboard(
    { state: store.state, ledger: ledger.status([day]), current: day, events: [], now: new Date() },
    40,
  );
  assert.ok(narrow.split("\n").every((line) => line.length <= 40));
});

test("the terminal view uses the alternate screen and restores the terminal on close", async () => {
  const { createTerminalView } = await import("../src/ui/dashboard.ts");
  const writes: string[] = [];
  const fake = {
    columns: 80,
    write: (s: string) => writes.push(s),
  } as unknown as NodeJS.WriteStream;
  const view = createTerminalView(fake, 0);
  const input = {
    state: { eventYear: 2025, puzzles: {}, submitNotBefore: undefined },
    ledger: {
      eventYear: 2025,
      fault: undefined,
      pendingOverruns: [],
      overshoot: [],
      held: [],
      counters: [],
    },
    current: undefined,
    events: ["synthetic event"],
    now: new Date("2025-12-01T00:00:00Z"),
  };
  view.update(input);
  await new Promise((r) => setTimeout(r, 5));
  view.close();
  view.update(input);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(writes[0], "\x1b[?1049h\x1b[?25l");
  assert.ok(writes[1]?.startsWith("\x1b[H\x1b[2J"));
  assert.match(writes[1] ?? "", /Bot of Code/);
  assert.equal(writes[2], "\x1b[?25h\x1b[?1049l");
  assert.match(writes[3] ?? "", /synthetic event/);
  assert.equal(writes.length, 4, "no drawing after close");
});
