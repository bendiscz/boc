import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { type Admission, createGuardedStreams } from "../src/pi/guarded-streams.ts";
import { FAKE_MODEL, message, responseStream } from "./support/fake-pi.ts";

const context = () =>
  normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 1 }] });

function fixture(admission?: Admission, transport?: ProviderStreams) {
  const requests: string[] = [];
  const held = new Set<string>();
  const settled: string[] = [];
  let calls = 0;
  const invoke = () => {
    calls++;
    return responseStream(message());
  };
  const guard = createGuardedStreams({
    model: FAKE_MODEL,
    admission: admission ?? {
      reserve: async (request) => {
        requests.push(request.id);
        held.add(request.id);
        return {
          settle: async () => {
            held.delete(request.id);
            settled.push(request.id);
          },
        };
      },
    },
    transport: transport ?? { stream: invoke, streamSimple: invoke },
  });
  return { guard, requests, held, settled, calls: () => calls };
}

test("both stream entry points reserve once before transport, then settle", async () => {
  const f = fixture();
  for (const method of ["stream", "streamSimple"] as const) {
    const result = await f.guard[method](FAKE_MODEL, context()).result();
    assert.equal(result.stopReason, "stop");
  }
  assert.equal(f.calls(), 2);
  assert.equal(new Set(f.requests).size, 2);
  assert.deepEqual(f.settled, f.requests);
  assert.equal(f.held.size, 0);
});

test("denial terminates the stream without transport or raw error disclosure", async () => {
  const f = fixture({
    reserve: async () => {
      throw new Error("secret-sentinel");
    },
  });
  const result = await f.guard.streamSimple(FAKE_MODEL, context()).result();
  assert.equal(result.stopReason, "error");
  assert.doesNotMatch(JSON.stringify(result), /secret-sentinel/);
  assert.equal(f.calls(), 0);
});

test("transport waits for completed admission", async () => {
  const wait = Promise.withResolvers<void>();
  const f = fixture({
    reserve: async () => {
      await wait.promise;
      return { settle: async () => {} };
    },
  });
  const stream = f.guard.stream(FAKE_MODEL, context());
  await new Promise(setImmediate);
  assert.equal(f.calls(), 0);
  wait.resolve();
  assert.equal((await stream.result()).stopReason, "stop");
  assert.equal(f.calls(), 1);
});

test("terminal success waits for settlement", async () => {
  const settlement = Promise.withResolvers<void>();
  const settling = Promise.withResolvers<void>();
  const f = fixture({
    reserve: async () => ({
      settle: async () => {
        settling.resolve();
        await settlement.promise;
      },
    }),
  });
  const stream = f.guard.stream(FAKE_MODEL, context());
  let complete = false;
  const result = stream.result().then((value) => {
    complete = true;
    return value;
  });
  await settling.promise;
  assert.equal(complete, false);
  settlement.resolve();
  assert.equal((await result).stopReason, "stop");
});

test("missing receipt/failed settlement retains reservation and faults future requests", async () => {
  let reservations = 0;
  const f = fixture({
    reserve: async () => {
      reservations++;
      return {
        settle: async () => {
          throw new Error("unknown charge secret-sentinel");
        },
      };
    },
  });
  for (let i = 0; i < 2; i++) {
    const result = await f.guard.stream(FAKE_MODEL, context()).result();
    assert.equal(result.stopReason, "error");
    assert.doesNotMatch(JSON.stringify(result), /secret-sentinel/);
  }
  assert.equal(reservations, 1);
  assert.equal(f.calls(), 1);
});

test("different model/provider/api/endpoint is rejected before admission", async () => {
  for (const change of [
    { id: "other" },
    { provider: "openai-codex" },
    { api: "openai-responses" },
    { baseUrl: "https://example.com" },
  ]) {
    const f = fixture();
    const result = await f.guard.stream({ ...FAKE_MODEL, ...change }, context()).result();
    assert.equal(result.stopReason, "error");
    assert.equal(f.requests.length, 0);
    assert.equal(f.calls(), 0);
  }
});

test("retry and alternate transport requests fail closed", async () => {
  for (const options of [
    { maxRetries: 1 },
    { maxRetries: -1 },
    { transport: "auto" as const },
    { transport: "websocket" as const },
  ]) {
    const f = fixture();
    assert.equal(
      (await f.guard.stream(FAKE_MODEL, context(), options).result()).stopReason,
      "error",
    );
    assert.equal(f.calls(), 0);
    assert.equal(f.requests.length, 0);
  }
});

test("synchronous transport throws and incomplete streams do not settle or retry", async () => {
  for (const invoke of [
    () => {
      throw new Error("transport secret-sentinel");
    },
    () => {
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    },
  ]) {
    let held = 0;
    let calls = 0;
    const dispatch = () => {
      calls++;
      return invoke();
    };
    const f = fixture(
      {
        reserve: async () => {
          held++;
          return {
            settle: async () => {
              held--;
            },
          };
        },
      },
      { stream: dispatch, streamSimple: dispatch },
    );
    const result = await f.guard.stream(FAKE_MODEL, context()).result();
    assert.equal(result.stopReason, "error");
    assert.equal(held, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret-sentinel/);
    await f.guard.stream(FAKE_MODEL, context()).result();
    assert.equal(calls, 1);
  }
});

test("abort before admission does not reserve", async () => {
  const f = fixture();
  const result = await f.guard
    .stream(FAKE_MODEL, context(), { signal: AbortSignal.abort() })
    .result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(f.requests.length, 0);
  assert.equal(f.calls(), 0);
});

test("abort during admission cannot dispatch and conservatively retains the reservation", async () => {
  const wait = Promise.withResolvers<void>();
  let settled = false;
  const controller = new AbortController();
  const f = fixture({
    reserve: async () => {
      await wait.promise;
      return {
        settle: async () => {
          settled = true;
        },
      };
    },
  });
  const stream = f.guard.stream(FAKE_MODEL, context(), { signal: controller.signal });
  controller.abort();
  wait.resolve();
  assert.equal((await stream.result()).stopReason, "aborted");
  assert.equal(settled, false);
  assert.equal(f.calls(), 0);
});

test("payload snapshots cannot be race-mutated by caller or admission", async () => {
  const wait = Promise.withResolvers<void>();
  let observed = "";
  const f = fixture(
    {
      reserve: async (request) => {
        // The admitted snapshot is deeply frozen: mutation attempts throw.
        assert.throws(() => {
          request.context.messages.length = 0;
        }, TypeError);
        assert.throws(() => {
          (request.model as { baseUrl: string }).baseUrl = "https://example.com";
        }, TypeError);
        await wait.promise;
        return { settle: async () => {} };
      },
    },
    {
      stream: (model, input, options) => {
        assert.equal(model.baseUrl, FAKE_MODEL.baseUrl);
        assert.equal(options?.maxRetries, 0);
        assert.equal(options?.transport, "sse");
        observed = JSON.stringify(input);
        return responseStream(message());
      },
      streamSimple: () => {
        throw new Error("Unexpected route.");
      },
    },
  );
  const input = context();
  const original = JSON.stringify(input);
  const stream = f.guard.stream(FAKE_MODEL, input);
  input.messages.length = 0;
  wait.resolve();
  assert.equal((await stream.result()).stopReason, "stop");
  assert.equal(observed, original);
});

test("known billable provider errors can settle but are sanitized", async () => {
  let settled = false;
  const invoke = () =>
    responseStream(message({ stopReason: "error", errorMessage: "private-provider-error" }));
  const f = fixture(
    {
      reserve: async () => ({
        settle: async (result) => {
          assert.equal(result.stopReason, "error");
          settled = true;
        },
      }),
    },
    { stream: invoke, streamSimple: invoke },
  );
  const result = await f.guard.stream(FAKE_MODEL, context()).result();
  assert.equal(settled, true);
  assert.equal(result.stopReason, "error");
  assert.doesNotMatch(JSON.stringify(result), /private-provider-error/);
});

test("pre-admission denial does not fault the boundary", async () => {
  let deny = true;
  const f = fixture({
    reserve: async () => {
      if (deny) throw new Error("Budget exhausted.");
      return { settle: async () => {} };
    },
  });
  assert.equal((await f.guard.stream(FAKE_MODEL, context()).result()).stopReason, "error");
  assert.equal(
    (await f.guard.stream({ ...FAKE_MODEL, id: "other" }, context()).result()).stopReason,
    "error",
  );
  assert.equal(
    (await f.guard.stream(FAKE_MODEL, context(), { maxRetries: 2 }).result()).stopReason,
    "error",
  );
  deny = false;
  assert.equal((await f.guard.stream(FAKE_MODEL, context()).result()).stopReason, "stop");
  assert.equal(f.calls(), 1);
});

test("request-rewriting options are dropped; admission and transport see the same snapshot", async () => {
  let admitted: unknown;
  let sent: unknown;
  const invoke: ProviderStreams["stream"] = (_model, _context, options) => {
    sent = options;
    return responseStream(message());
  };
  const f = fixture(
    {
      reserve: async (request) => {
        admitted = request.options;
        return { settle: async () => {} };
      },
    },
    { stream: invoke, streamSimple: invoke },
  );
  const headers: Record<string, string> = { "x-auth": "synthetic" };
  const rewriting = {
    headers,
    maxTokens: 64,
    onPayload: () => ({ model: "other" }),
    fetch: globalThis.fetch,
    env: { OPENAI_BASE_URL: "https://example.com" },
    samplingParams: { max_output_tokens: 999999 },
    metadata: { x: 1 },
    transformHeaders: (h: object) => h,
    unknownKey: true,
  };
  const stream = f.guard.stream(FAKE_MODEL, context(), rewriting as never);
  headers["x-auth"] = "mutated";
  assert.equal((await stream.result()).stopReason, "stop");
  // The transport always receives the guard's own abort signal (streaming cutoff).
  const { signal, ...rest } = sent as { signal?: unknown };
  assert.ok(signal instanceof AbortSignal);
  sent = rest;
  assert.deepEqual(sent, admitted);
  assert.deepEqual(sent, {
    transport: "sse",
    maxRetries: 0,
    maxTokens: 64,
    headers: { "x-auth": "synthetic" },
  });
  assert.ok(Object.isFrozen(admitted));
});

test("aborted or deferred terminal outcomes are uncertain: never settled, boundary faults", async () => {
  for (const stopReason of ["aborted", "deferred"] as const) {
    let settled = false;
    let calls = 0;
    const invoke = () => {
      calls++;
      const s = createAssistantMessageEventStream();
      const m = message({ stopReason });
      s.push({ type: "start", partial: m });
      if (stopReason === "aborted") s.push({ type: "error", reason: "aborted", error: m });
      else s.push({ type: "done", reason: "stop", message: m });
      s.end();
      return s;
    };
    const f = fixture(
      {
        reserve: async () => ({
          settle: async () => {
            settled = true;
          },
        }),
      },
      { stream: invoke, streamSimple: invoke },
    );
    assert.notEqual((await f.guard.stream(FAKE_MODEL, context()).result()).stopReason, "stop");
    await f.guard.stream(FAKE_MODEL, context()).result();
    assert.equal(settled, false);
    assert.equal(calls, 1);
  }
});
