import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCredits } from "../src/budget/credits.ts";
import { CreditLedger, LedgerError, ledgerDirectory } from "../src/budget/ledger.ts";
import { type BocConfig, parseConfig } from "../src/config.ts";
import { puzzleId } from "../src/state/ids.ts";

const c = parseCredits;
const day1 = puzzleId(1);
const day2 = puzzleId(2);

function config(overrides: {
  year?: number;
  subA?: [string, string];
  subB?: [string, string];
  poolCopilot?: [string, string];
  poolCodex?: [string, string];
  unit?: string;
  rename?: string;
}): BocConfig {
  const limits = (pair: [string, string] | undefined, fallback: [string, string]) => {
    const [event, perPuzzle] = pair ?? fallback;
    return { event, perPuzzle };
  };
  return parseConfig({
    version: 1,
    event: { year: overrides.year ?? 2025 },
    storageDir: "/synthetic/var",
    aoc: { sessionCookieFile: "/synthetic/cookie" },
    creditPools: [
      {
        id: "copilot-pool",
        provider: "github-copilot",
        unit: overrides.unit ?? "copilot-credit",
        limits: limits(overrides.poolCopilot, ["100", "10"]),
      },
      {
        id: "codex-pool",
        provider: "openai-codex",
        unit: "codex-credit",
        limits: limits(overrides.poolCodex, ["100", "10"]),
      },
    ],
    subscriptions: [
      {
        id: overrides.rename ?? "copilot-a",
        provider: "github-copilot",
        credentialFile: "/synthetic/a",
        model: "synthetic",
        creditPool: "copilot-pool",
        limits: limits(overrides.subA, ["100", "10"]),
      },
      {
        id: "copilot-b",
        provider: "github-copilot",
        credentialFile: "/synthetic/b",
        model: "synthetic",
        creditPool: "copilot-pool",
        limits: limits(overrides.subB, ["100", "10"]),
      },
      {
        id: "codex",
        provider: "openai-codex",
        credentialFile: "/synthetic/c",
        model: "synthetic",
        creditPool: "codex-pool",
        limits: { event: "100", perPuzzle: "10" },
      },
    ],
  });
}

async function directory(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "boc-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "ledger");
}

async function openLedger(t: test.TestContext, dir: string, cfg = config({})) {
  const ledger = await CreditLedger.open({ directory: dir, config: cfg });
  t.after(() => ledger.close().catch(() => {}));
  return ledger;
}

let counter = 0;
const reserve = (ledger: CreditLedger, amount: string, subscription = "copilot-a", puzzle = day1) =>
  ledger
    .reserve({ id: `r-${++counter}`, subscription, puzzle, amount: c(amount), operation: "test" })
    .then(() => `r-${counter}`);

function counterOf(ledger: CreditLedger, scope: string, id: string, period: string) {
  const found = ledger
    .status([day1, day2])
    .counters.find((x) => x.scope === scope && x.id === id && x.period === period);
  assert.ok(found);
  return found;
}

const denied = (error: unknown) => error instanceof LedgerError && error.code === "denied";

test("reserve then settle moves credits from reserved to spent on all four counters", async (t) => {
  const ledger = await openLedger(t, await directory(t));
  const id = await reserve(ledger, "3.5");
  for (const [scope, name] of [
    ["subscription", "copilot-a"],
    ["pool", "copilot-pool"],
  ] as const) {
    for (const period of ["event", day1]) {
      const x = counterOf(ledger, scope, name, period);
      assert.equal(x.reserved, c("3.5"));
      assert.equal(x.spent, 0n);
    }
  }
  await ledger.settle(id, c("1.25"), "receipt:synthetic-1");
  const x = counterOf(ledger, "pool", "copilot-pool", day1);
  assert.equal(x.reserved, 0n);
  assert.equal(x.spent, c("1.25"));
  assert.equal(x.remaining, c("8.75"));
  assert.equal(counterOf(ledger, "subscription", "copilot-b", day1).spent, 0n);
  assert.deepEqual(ledger.status().held, []);
});

test("each of the four counters independently enforces its exact boundary", async (t) => {
  const cases: [string, Parameters<typeof config>[0], string, string][] = [
    ["subscription per-puzzle", { subA: ["100", "2"] }, "2", "0.000000000000000001"],
    ["subscription event", { subA: ["2", "2"] }, "2", "0.000000000000000001"],
    ["pool per-puzzle", { poolCopilot: ["100", "2"] }, "2", "0.000000000000000001"],
    ["pool event", { poolCopilot: ["2", "2"] }, "2", "0.000000000000000001"],
  ];
  for (const [name, overrides, fits, extra] of cases) {
    const ledger = await openLedger(t, await directory(t), config(overrides));
    await reserve(ledger, fits);
    await assert.rejects(reserve(ledger, extra), denied, name);
    await ledger.close();
  }
});

test("per-puzzle limits are per puzzle; event limits span puzzles", async (t) => {
  const ledger = await openLedger(t, await directory(t), config({ subA: ["15", "10"] }));
  await reserve(ledger, "10", "copilot-a", day1);
  await assert.rejects(reserve(ledger, "1", "copilot-a", day1), denied);
  await reserve(ledger, "5", "copilot-a", day2);
  await assert.rejects(reserve(ledger, "0.1", "copilot-a", day2), denied);
});

test("shared pools bind across subscriptions; separate provider pools do not", async (t) => {
  const ledger = await openLedger(t, await directory(t), config({ poolCopilot: ["100", "6"] }));
  await reserve(ledger, "4", "copilot-a");
  await assert.rejects(reserve(ledger, "3", "copilot-b"), denied);
  await reserve(ledger, "2", "copilot-b");
  await reserve(ledger, "10", "codex");
  assert.equal(counterOf(ledger, "pool", "codex-pool", day1).remaining, 0n);
  assert.equal(counterOf(ledger, "pool", "copilot-pool", day1).remaining, 0n);
});

test("concurrent admissions never oversubscribe", async (t) => {
  const ledger = await openLedger(t, await directory(t));
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => reserve(ledger, "3", "copilot-a")),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.ok(results.every((r) => r.status === "fulfilled" || denied(r.reason)));
  assert.equal(counterOf(ledger, "pool", "copilot-pool", day1).reserved, c("9"));
});

test("invalid or unaccounted operations are rejected without state change", async (t) => {
  const ledger = await openLedger(t, await directory(t));
  const invalid = (error: unknown) => error instanceof LedgerError && error.code === "invalid";
  const base = { id: "x-1", subscription: "copilot-a", puzzle: day1, operation: "test" };
  await assert.rejects(ledger.reserve({ ...base, amount: c("0") }), invalid);
  await assert.rejects(ledger.reserve({ ...base, amount: -1n as never }), invalid);
  await assert.rejects(ledger.reserve({ ...base, amount: 1 as never }), invalid);
  await assert.rejects(ledger.reserve({ ...base, subscription: "nope", amount: c("1") }), invalid);
  await assert.rejects(ledger.reserve({ ...base, puzzle: "day-1" as never, amount: c("1") }));
  await assert.rejects(ledger.reserve({ ...base, operation: "Bad Op", amount: c("1") }), invalid);
  await ledger.reserve({ ...base, amount: c("1") });
  await assert.rejects(ledger.reserve({ ...base, amount: c("1") }), invalid, "duplicate id");
  await assert.rejects(ledger.settle("unknown", c("1"), "receipt:1"), invalid);
  await assert.rejects(ledger.settle("x-1", c("1"), "free text with spaces"), invalid);
  await ledger.settle("x-1", c("1"), "receipt:1");
  await assert.rejects(ledger.settle("x-1", c("1"), "receipt:1"), invalid, "double settle");
  assert.equal(counterOf(ledger, "pool", "copilot-pool", day1).spent, c("1"));
});

test("held reservations survive restart as orphaned and can be reconciled later", async (t) => {
  const dir = await directory(t);
  let ledger = await openLedger(t, dir);
  const held = await reserve(ledger, "4");
  const settled = await reserve(ledger, "2");
  await ledger.settle(settled, c("2"), "receipt:2");
  const uncertain = await reserve(ledger, "3");
  await ledger.markUncertain(uncertain, "stream-aborted");
  await ledger.close();

  ledger = await openLedger(t, dir);
  const status = ledger.status();
  assert.deepEqual(status.held.map((h) => [h.id, h.orphaned, h.uncertain]).sort(), [
    [held, true, undefined],
    [uncertain, true, "stream-aborted"],
  ]);
  const x = counterOf(ledger, "pool", "copilot-pool", day1);
  assert.equal(x.reserved, c("7"));
  assert.equal(x.spent, c("2"));
  await assert.rejects(reserve(ledger, "1.000000000000000001"), denied);
  await ledger.settle(held, c("0.5"), "receipt:reconciled");
  await reserve(ledger, "4.5");
});

test("a crashed owner's lock blocks opening until proven stale", async (t) => {
  const dir = await directory(t);
  const first = await openLedger(t, dir);
  await reserve(first, "1");
  // Simulate a crash: the first instance never closes; its lock and journal remain.
  await assert.rejects(
    CreditLedger.open({ directory: dir, config: config({}) }),
    (e) => e instanceof LedgerError && e.code === "locked",
  );
  await assert.rejects(CreditLedger.breakStaleLock(dir), /still running/);
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  const deadPid = Number(child.stdout.toString());
  await writeFile(join(dir, "journal.lock"), JSON.stringify({ pid: deadPid, host: hostname() }));
  await CreditLedger.breakStaleLock(dir);
  const second = await openLedger(t, dir);
  assert.equal(counterOf(second, "pool", "copilot-pool", day1).reserved, c("1"));
  assert.equal(second.status().held[0]?.orphaned, true);
  await writeFile(join(dir, "journal.lock"), JSON.stringify({ pid: deadPid, host: "elsewhere" }));
  await assert.rejects(CreditLedger.breakStaleLock(dir), /another host/);
});

test("a torn final record is dropped; other corruption refuses to open", async (t) => {
  const dir = await directory(t);
  let ledger = await openLedger(t, dir);
  await reserve(ledger, "1");
  await ledger.close();
  const journal = join(dir, "journal.jsonl");
  const intact = await readFile(journal, "utf8");
  await writeFile(journal, `${intact}{"seq":99,"type":"res`);
  ledger = await openLedger(t, dir);
  assert.equal(ledger.status().held.length, 1);
  await ledger.close();
  assert.ok((await readFile(journal, "utf8")).startsWith(intact));

  const corrupt = (e: unknown) => e instanceof LedgerError && e.code === "corrupt";
  const lines = intact.trimEnd().split("\n");
  for (const variant of [
    [...lines.slice(0, 1), "not json", ...lines.slice(1)],
    [lines[0], lines[2], lines[1]],
    [lines[0], lines[1], lines[1]],
    [lines[0], lines[1], lines[2]?.replace('"amount":"1"', '"amount":"1.0000000000000000001"')],
    [lines[0], lines[1], lines[2]?.replace('"type":"reserve"', '"type":"settle"')],
    [lines[1]?.replace('"seq":2', '"seq":1')],
    [lines[0], lines[1]?.replace('"type":"open"', '"type":"open","extra":1')],
  ]) {
    await writeFile(journal, `${variant.join("\n")}\n`);
    await assert.rejects(CreditLedger.open({ directory: dir, config: config({}) }), corrupt);
  }
});

test("configuration changes cannot reset history", async (t) => {
  const dir = await directory(t);
  const ledger = await openLedger(t, dir);
  await reserve(ledger, "1");
  await ledger.close();
  const mismatch = (e: unknown) => e instanceof LedgerError && e.code === "config-mismatch";
  for (const cfg of [
    config({ year: 2024 }),
    config({ rename: "copilot-renamed" }),
    config({ unit: "other-unit" }),
  ]) {
    await assert.rejects(CreditLedger.open({ directory: dir, config: cfg }), mismatch);
  }
  // Lowering limits is allowed; existing usage counts against the new limits.
  const lowered = await openLedger(t, dir, config({ subA: ["1", "1"] }));
  await assert.rejects(reserve(lowered, "0.000000000000000001"), denied);
});

test("an overrun is recorded truthfully; excess beyond the pool tolerance blocks that pool", async (t) => {
  const dir = await directory(t);
  let ledger = await openLedger(t, dir);
  // Default tolerance: 5% of the copilot pool's event limit of 100 = 5.
  const small = await reserve(ledger, "2", "copilot-a", day2);
  await ledger.settle(small, c("6"), "receipt:small", "derived");
  assert.deepEqual(ledger.status().pendingOverruns, [small]);
  const pool = ledger.status().overshoot.find((o) => o.pool === "copilot-pool");
  assert.deepEqual(pool, {
    pool: "copilot-pool",
    excess: c("4"),
    tolerance: c("5"),
    blocking: false,
  });
  await reserve(ledger, "1", "copilot-b", day2); // still within tolerance: best effort continues

  const id = await reserve(ledger, "2");
  await ledger.settle(id, c("12"), "receipt:overrun");
  const x = counterOf(ledger, "subscription", "copilot-a", day1);
  assert.equal(x.spent, c("12"));
  assert.equal(x.exceeded, true);
  assert.equal(x.remaining, 0n);
  await assert.rejects(reserve(ledger, "1", "copilot-b", day2), denied, "excess 14 > tolerance 5");
  await reserve(ledger, "1", "codex"); // another pool is unaffected
  await ledger.close();
  ledger = await openLedger(t, dir);
  assert.equal(ledger.status().overshoot.find((o) => o.pool === "copilot-pool")?.blocking, true);
  await assert.rejects(reserve(ledger, "1", "copilot-b", day2), denied);
  await ledger.acknowledgeOverrun(id, "operator-reviewed");
  await reserve(ledger, "1", "copilot-b", day2);
  await assert.rejects(reserve(ledger, "0.1", "copilot-a", day1), denied, "puzzle still exceeded");
});

test("a configured overshoot tolerance replaces the 5% default", async (t) => {
  const cfg = config({});
  const pool = cfg.creditPools[0];
  assert.ok(pool);
  pool.overshootTolerance = "0";
  const ledger = await openLedger(t, await directory(t), cfg);
  const id = await reserve(ledger, "1");
  await ledger.settle(id, c("1.000000000000000001"), "receipt:tiny");
  await assert.rejects(reserve(ledger, "1", "copilot-b"), denied);
});

test("a failed journal sync faults the ledger and counts the reservation as held", async (t) => {
  const dir = await directory(t);
  const ledger = await openLedger(t, dir);
  const probe = await open(join(dir, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const original = prototype.sync;
  prototype.sync = async () => {
    throw new Error("synthetic EIO with /private/path");
  };
  try {
    await assert.rejects(reserve(ledger, "4"), (e) => {
      assert.ok(e instanceof LedgerError && e.code === "faulted");
      assert.doesNotMatch(e.message, /private/);
      return true;
    });
  } finally {
    prototype.sync = original;
  }
  assert.equal(ledger.status().fault, "journal-write-failed");
  assert.equal(counterOf(ledger, "pool", "copilot-pool", day1).reserved, c("4"));
  await assert.rejects(reserve(ledger, "1", "codex"), /faulted/);
});

test("ledger files are private and closed ledgers reject work", async (t) => {
  const dir = await directory(t);
  const ledger = await openLedger(t, dir);
  assert.equal((await stat(dir)).mode & 0o077, 0);
  assert.equal((await stat(join(dir, "journal.jsonl"))).mode & 0o077, 0);
  await ledger.close();
  await assert.rejects(reserve(ledger, "1"), /closed/);
  await assert.rejects(stat(join(dir, "journal.lock")));
  assert.equal(ledgerDirectory(config({})), join("/synthetic/var", "ledger", "2025"));
});

test("close drains operations queued before it and rejects later ones", async (t) => {
  const dir = await directory(t);
  const ledger = await openLedger(t, dir);
  const queued = [reserve(ledger, "1"), reserve(ledger, "2")];
  const closing = ledger.close();
  await assert.rejects(reserve(ledger, "1"), /closed/);
  await Promise.all([...queued, closing]);
  const reopened = await openLedger(t, dir);
  assert.equal(counterOf(reopened, "pool", "copilot-pool", day1).reserved, c("3"));
});

test("read-only inspection needs no lock, modifies nothing, and ignores a torn tail", async (t) => {
  const dir = await directory(t);
  const ledger = await openLedger(t, dir);
  await reserve(ledger, "2");
  const journal = join(dir, "journal.jsonl");
  const inspected = await CreditLedger.inspect({ directory: dir, config: config({}) });
  assert.equal(inspected.held.length, 1);
  assert.equal(inspected.held[0]?.orphaned, false, "the running owner's hold is live");
  await ledger.close();
  const intact = await readFile(journal, "utf8");
  await writeFile(journal, `${intact}{"seq":`);
  const again = await CreditLedger.inspect({ directory: dir, config: config({}) });
  assert.equal(again.held.length, 1);
  assert.equal(await readFile(journal, "utf8"), `${intact}{"seq":`);
  const missing = await CreditLedger.inspect({ directory: join(dir, "none"), config: config({}) });
  assert.deepEqual(missing.held, []);
});
