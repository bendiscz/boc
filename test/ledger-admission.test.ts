import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type CreditMeter, createLedgerAdmission } from "../src/budget/admission.ts";
import { parseCredits } from "../src/budget/credits.ts";
import { CreditLedger } from "../src/budget/ledger.ts";
import { parseConfig } from "../src/config.ts";
import { createGuardedStreams } from "../src/pi/guarded-streams.ts";
import { puzzleId } from "../src/state/ids.ts";
import { FAKE_MODEL, fakeSession, message, responseStream } from "./support/fake-pi.ts";

const c = parseCredits;
const day = puzzleId(3);

const config = parseConfig({
  version: 1,
  event: { year: 2025 },
  storageDir: "/synthetic/var",
  aoc: { sessionCookieFile: "/synthetic/cookie" },
  creditPools: [
    {
      id: "pool",
      provider: "github-copilot",
      unit: "synthetic-credit",
      limits: { event: "100", perPuzzle: "3" },
    },
  ],
  subscriptions: [
    {
      id: "sub",
      provider: "github-copilot",
      credentialFile: "/synthetic/cred",
      model: FAKE_MODEL.id,
      creditPool: "pool",
      limits: { event: "100", perPuzzle: "100" },
    },
  ],
});

async function setup(t: test.TestContext, meter: Partial<CreditMeter> = {}) {
  const root = await mkdtemp(join(tmpdir(), "boc-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "ledger");
  const ledger = await CreditLedger.open({ directory, config });
  t.after(() => ledger.close().catch(() => {}));
  let receipts = 0;
  const admission = createLedgerAdmission({
    ledger,
    subscription: "sub",
    model: FAKE_MODEL.id,
    puzzle: day,
    meter: {
      maxCharge: () => c("1"),
      actualCharge: async () => ({ credits: c("0.25"), receipt: `receipt:${++receipts}` }),
      ...meter,
    },
  });
  let calls = 0;
  const invoke = () => {
    calls++;
    return responseStream(message());
  };
  const guard = createGuardedStreams({
    model: FAKE_MODEL,
    admission,
    transport: { stream: invoke, streamSimple: invoke },
  });
  const pool = () => ledger.status().counters.find((x) => x.scope === "pool" && x.period === day);
  return { root, directory, ledger, admission, guard, calls: () => calls, pool };
}

const context = () =>
  normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 1 }] });

test("a guarded dispatch reserves the bound durably and settles the receipt", async (t) => {
  const f = await setup(t);
  const result = await f.guard.streamSimple(FAKE_MODEL, context()).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(f.calls(), 1);
  assert.equal(f.pool()?.spent, c("0.25"));
  assert.equal(f.pool()?.reserved, 0n);
  const journal = await readFile(join(f.directory, "journal.jsonl"), "utf8");
  assert.match(journal, /"type":"reserve".*"amount":"1"/);
  assert.match(journal, /"type":"settle".*"actual":"0.25".*"evidence":"receipt:1"/);
  assert.doesNotMatch(journal, /synthetic-not-a-secret|"synthetic"(?!-)/);
});

test("no certified bound means no reservation and no dispatch", async (t) => {
  const f = await setup(t, {
    maxCharge: () => {
      throw new Error("unknown cost");
    },
  });
  assert.equal((await f.guard.stream(FAKE_MODEL, context()).result()).stopReason, "error");
  assert.equal(f.calls(), 0);
  assert.equal(f.pool()?.reserved, undefined, "no counters touched for this puzzle");
});

test("a missing receipt keeps the reservation held, marked uncertain", async (t) => {
  const f = await setup(t, {
    actualCharge: async () => {
      throw new Error("no receipt");
    },
  });
  assert.equal((await f.guard.stream(FAKE_MODEL, context()).result()).stopReason, "error");
  assert.equal(f.pool()?.reserved, c("1"));
  assert.equal(f.ledger.status().held[0]?.uncertain, "receipt-unavailable");
  // The guard is now faulted: further dispatches are refused without reserving.
  assert.equal((await f.guard.stream(FAKE_MODEL, context()).result()).stopReason, "error");
  assert.equal(f.calls(), 1);
  assert.equal(f.pool()?.reserved, c("1"));
});

test("a model not configured for the subscription is denied", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.admission.reserve({
      id: "forged",
      model: { ...FAKE_MODEL, id: "other" },
      context: context(),
      options: {},
      signal: undefined,
    }),
  );
  assert.equal(f.ledger.status().held.length, 0);
});

test("a Pi tool loop stops when the durable per-puzzle pool limit is exhausted", async (t) => {
  const f = await setup(t, {
    actualCharge: async () => ({ credits: c("1"), receipt: "receipt:loop" }),
  });
  let executions = 0;
  const tool = defineTool({
    name: "synthetic_tool",
    label: "Synthetic tool",
    description: "Synthetic offline tool.",
    parameters: Type.Object({}),
    execute: async () => {
      executions++;
      return { content: [{ type: "text", text: "again" }], details: {} };
    },
  });
  const session = await fakeSession({
    cwd: f.root,
    admission: f.admission,
    tools: [tool],
    respond: () =>
      message({
        content: [
          { type: "toolCall", id: `call-${executions}`, name: "synthetic_tool", arguments: {} },
        ],
        stopReason: "toolUse",
      }),
  });
  t.after(() => session.session.dispose());
  await session.session.prompt("loop forever");
  assert.equal(session.calls.length, 3, "pool per-puzzle limit 3 at 1 credit each");
  assert.equal(executions, 3);
  assert.equal(f.pool()?.spent, c("3"));
  assert.equal(f.pool()?.remaining, 0n);
});

test("abort after admission keeps the reservation held, annotated not-dispatched", async (t) => {
  const controller = new AbortController();
  const f = await setup(t, {
    maxCharge: () => {
      // Abort lands while the durable reservation is being written.
      queueMicrotask(() => controller.abort());
      return c("1");
    },
  });
  const result = await f.guard
    .stream(FAKE_MODEL, context(), { signal: controller.signal })
    .result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(f.calls(), 0);
  assert.equal(f.pool()?.reserved, c("1"));
  assert.equal(f.ledger.status().held[0]?.uncertain, "not-dispatched");
});

test("a transport failure after dispatch is annotated outcome-uncertain", async (t) => {
  const f = await setup(t);
  const broken = createGuardedStreams({
    model: FAKE_MODEL,
    admission: f.admission,
    transport: {
      stream: () => {
        throw new Error("synthetic transport failure");
      },
      streamSimple: () => {
        throw new Error("synthetic transport failure");
      },
    },
  });
  assert.equal((await broken.stream(FAKE_MODEL, context()).result()).stopReason, "error");
  assert.equal(f.pool()?.reserved, c("1"));
  assert.equal(f.ledger.status().held[0]?.uncertain, "outcome-uncertain");
});
