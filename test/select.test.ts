import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCredits } from "../src/budget/credits.ts";
import { CreditLedger } from "../src/budget/ledger.ts";
import { selectSubscription } from "../src/budget/select.ts";
import { parseConfig } from "../src/config.ts";
import { puzzleId } from "../src/state/ids.ts";

const config = parseConfig({
  version: 1,
  event: { year: 2025 },
  storageDir: "/synthetic",
  aoc: { sessionCookieFile: "/synthetic/cookie" },
  creditPools: [
    {
      id: "copilot",
      provider: "github-copilot",
      unit: "a",
      limits: { event: "10", perPuzzle: "5" },
    },
    { id: "codex", provider: "openai-codex", unit: "b", limits: { event: "10", perPuzzle: "5" } },
  ],
  subscriptions: [
    {
      id: "first",
      provider: "github-copilot",
      credentialFile: "/s/1",
      model: "m",
      creditPool: "copilot",
      limits: { event: "10", perPuzzle: "3" },
    },
    {
      id: "second",
      provider: "openai-codex",
      credentialFile: "/s/2",
      model: "m",
      creditPool: "codex",
      limits: { event: "10", perPuzzle: "5" },
    },
  ],
});

test("selection prefers configured order, skips exhausted, ineligible, or unbounded subscriptions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "boc-select-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = await CreditLedger.open({ directory: dir, config });
  t.after(() => ledger.close().catch(() => {}));
  const day = puzzleId(1);
  const pick = (overrides: Partial<Parameters<typeof selectSubscription>[0]> = {}) =>
    selectSubscription({
      config,
      ledger: ledger.status([day]),
      puzzle: day,
      eligible: () => true,
      minimum: () => parseCredits("1"),
      ...overrides,
    });
  assert.equal(pick(), "first");
  assert.equal(pick({ eligible: (id) => id !== "first" }), "second");
  assert.equal(pick({ exclude: new Set(["first"]) }), "second");
  assert.equal(
    pick({ minimum: (id) => (id === "first" ? undefined : parseCredits("1")) }),
    "second",
  );
  assert.equal(pick({ minimum: () => parseCredits("0") }), undefined);
  await ledger.reserve({
    id: "r1",
    subscription: "first",
    puzzle: day,
    amount: parseCredits("2.5"),
    operation: "t",
  });
  assert.equal(pick(), "second", "first has only 0.5 left for this puzzle");
  assert.equal(pick({ minimum: () => parseCredits("0.5") }), "first");
  assert.equal(
    pick({ ledger: ledger.status(), puzzle: puzzleId(2) }),
    undefined,
    "puzzle counters are required",
  );
  await ledger.settle("r1", parseCredits("9"), "receipt:over");
  assert.equal(pick(), undefined, "an unacknowledged overrun blocks every subscription");
});
