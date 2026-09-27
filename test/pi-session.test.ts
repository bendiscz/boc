import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { defineTool, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Admission } from "../src/pi/guarded-streams.ts";
import {
  FAKE_MODEL,
  fakeRuntime,
  fakeSession,
  message,
  responseStream,
} from "./support/fake-pi.ts";

async function workspace(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "boc-pi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function counting(limit = Number.POSITIVE_INFINITY) {
  const state = { attempts: 0, reserved: 0, settled: 0 };
  const admission: Admission = {
    reserve: async () => {
      state.attempts++;
      if (state.reserved >= limit) throw new Error("Budget exhausted.");
      state.reserved++;
      return {
        settle: async () => {
          state.settled++;
        },
      };
    },
  };
  return { state, admission };
}

test("a normal session turn is admitted exactly once, with no ambient auth lookup", async (t) => {
  const { state, admission } = counting();
  const f = await fakeSession({ cwd: await workspace(t), admission, respond: () => message() });
  t.after(() => f.session.dispose());
  await f.session.prompt("synthetic");
  assert.equal(state.reserved, 1);
  assert.equal(state.settled, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.getLastAssistantText(), "Synthetic answer.");
  assert.deepEqual(f.session.getActiveToolNames(), []);
  // Only the resource system prompt is used; no host AGENTS.md/context discovery.
  assert.doesNotMatch(f.session.systemPrompt, /BoC development instructions/);
});

test("every tool-loop generation is separately admitted; denial stops the loop", async (t) => {
  let executions = 0;
  const tool = defineTool({
    name: "synthetic_tool",
    label: "Synthetic tool",
    description: "Synthetic offline tool.",
    parameters: Type.Object({}),
    execute: async () => {
      executions++;
      return { content: [{ type: "text", text: "tool result" }], details: {} };
    },
  });
  const respond = (context: { messages: { role: string }[] }) =>
    context.messages.some((m) => m.role === "toolResult")
      ? message()
      : message({
          content: [{ type: "toolCall", id: "call-1", name: "synthetic_tool", arguments: {} }],
          stopReason: "toolUse",
        });

  const allowed = counting();
  const a = await fakeSession({
    cwd: await workspace(t),
    admission: allowed.admission,
    respond,
    tools: [tool],
  });
  t.after(() => a.session.dispose());
  await a.session.prompt("use the tool");
  assert.equal(allowed.state.reserved, 2);
  assert.equal(a.calls.length, 2);
  assert.equal(executions, 1);

  const limited = counting(1);
  const b = await fakeSession({
    cwd: await workspace(t),
    admission: limited.admission,
    respond,
    tools: [tool],
  });
  t.after(() => b.session.dispose());
  await b.session.prompt("use the tool");
  assert.equal(limited.state.reserved, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(
    executions,
    2,
    "the admitted first generation's tool may run; the second generation may not",
  );
});

test("denied first turn makes no transport call and automatic retry is disabled", async (t) => {
  const { state, admission } = counting(0);
  const f = await fakeSession({ cwd: await workspace(t), admission, respond: () => message() });
  t.after(() => f.session.dispose());
  await f.session.prompt("synthetic");
  assert.equal(state.attempts, 1, "a denied dispatch is not retried");
  assert.equal(state.reserved, 0);
  assert.equal(f.calls.length, 0);
});

// Note: the guard replaces provider error text with a fixed message, so Pi's
// retry classifier never sees "retryable" text; retry.enabled=false is a second layer.
test("a retryable-looking provider error is not retried by the session", async (t) => {
  const { state, admission } = counting();
  const f = await fakeSession({
    cwd: await workspace(t),
    admission,
    respond: () => message({ stopReason: "error", errorMessage: "503 overloaded, retry later" }),
  });
  t.after(() => f.session.dispose());
  await f.session.prompt("synthetic");
  assert.equal(f.calls.length, 1);
  assert.equal(state.attempts, 1);
  assert.equal(state.reserved, 1);
});

function compactableSettings() {
  // Same restrictive profile, but keep no recent tokens so a tiny history compacts.
  return SettingsManager.inMemory({
    defaultTools: [],
    compaction: { enabled: false, keepRecentTokens: 0 },
    branchSummary: { skipPrompt: true },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: "off",
    transport: "sse",
    enableInstallTelemetry: false,
    enableAnalytics: false,
    images: { blockImages: true },
  });
}

test("explicit compaction dispatches through admission", async (t) => {
  const { state, admission } = counting();
  const f = await fakeSession({
    cwd: await workspace(t),
    admission,
    respond: () => message({ content: [{ type: "text", text: "Summary." }] }),
    settings: compactableSettings(),
  });
  t.after(() => f.session.dispose());
  await f.session.prompt("synthetic");
  await f.session.prompt("again");
  const before = { reserved: state.reserved, calls: f.calls.length };
  await f.session.compact();
  assert.ok(state.reserved > before.reserved, "compaction must reserve");
  assert.equal(state.reserved - before.reserved, f.calls.length - before.calls);
});

test("explicit compaction is blocked when admission is exhausted", async (t) => {
  const { state, admission } = counting(2);
  const f = await fakeSession({
    cwd: await workspace(t),
    admission,
    respond: () => message(),
    settings: compactableSettings(),
  });
  t.after(() => f.session.dispose());
  await f.session.prompt("synthetic");
  await f.session.prompt("again");
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.session.compact(), (error: Error) => {
    assert.doesNotMatch(error.message, /Nothing to compact/);
    return true;
  });
  assert.ok(state.attempts > 2, "compaction attempted admission");
  assert.equal(f.calls.length, 2);
});

test("cache warming stays off: no extra calls after a turn", async (t) => {
  const { state, admission } = counting();
  const f = await fakeSession({ cwd: await workspace(t), admission, respond: () => message() });
  t.after(() => f.session.dispose());
  await f.session.prompt("synthetic");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.settings.getCacheWarmingMode(), "off");
  assert.equal(state.reserved, 1);
  assert.equal(f.calls.length, 1);
});

test("forged same-provider models cannot be selected or dispatched", async (t) => {
  const { state, admission } = counting();
  const f = await fakeSession({ cwd: await workspace(t), admission, respond: () => message() });
  t.after(() => f.session.dispose());
  const forged = { ...FAKE_MODEL, id: "forged", baseUrl: "https://example.com" };
  // Pi's setModel only checks provider auth, so selection is not a security boundary.
  await f.session.setModel(forged);
  await f.session.prompt("synthetic");
  assert.equal(f.calls.length, 0);
  assert.equal(state.attempts, 0, "the guard rejects the forged model before admission");
  assert.equal(f.session.messages.at(-1)?.role, "assistant");
  const direct = await f.runtime.completeSimple(forged, { messages: [] });
  assert.equal(direct.stopReason, "error");
  assert.equal(f.calls.length, 0);
});

test("runtime facade rejects unsupported operations and unknown providers", async () => {
  const { admission } = counting();
  let calls = 0;
  const invoke = () => {
    calls++;
    return responseStream(message());
  };
  const f = fakeRuntime(admission, { stream: invoke, streamSimple: invoke });
  const runtime = f.runtime as unknown as Record<string, unknown>;
  for (const operation of [
    "registerProvider",
    "registerNativeProvider",
    "refresh",
    "login",
    "setRuntimeApiKey",
    "streamDeferred",
    "fetchDeferred",
    "cancelDeferred",
  ]) {
    assert.throws(() => runtime[operation], /Unsupported/);
  }
  await assert.rejects(async () => f.runtime.checkAuth("openai-codex"));
  assert.throws(() =>
    f.runtime.stream({ ...FAKE_MODEL, provider: "openai-codex" }, { messages: [] }),
  );
  const result = await f.runtime.completeSimple(FAKE_MODEL, normalizeContext({ messages: [] }));
  assert.equal(result.stopReason, "stop");
  assert.equal(calls, 1);
});
