import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { type AssistantMessage, normalizeContext, Type } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { parseCredits, tokenCost } from "../src/budget/credits.ts";
import { parseConfig } from "../src/config.ts";
import { createGuardedStreams } from "../src/pi/guarded-streams.ts";
import { createCopilotAdapter } from "../src/providers/github-copilot.ts";
import { createCodexAdapter } from "../src/providers/openai-codex.ts";
import { createSolverAgent } from "../src/solver/agent.ts";

// Actual installed Pi providers, but every fetch is intercepted: no network,
// real tokens, account files, AoC requests, or model charges. Each test file has
// its own Node process; tests here run sequentially while the globals are mocked.
const providers = ["github-copilot", "openai-codex"] as const;
type ProviderId = (typeof providers)[number];
const modelId = "gpt-6.1-sol";
const syntheticToken = `synthetic.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
).toString("base64url")}.not-a-signature`;
const context = () =>
  normalizeContext({
    systemPrompt: "Synthetic wire test only.",
    messages: [{ role: "user", content: "Return 42.", timestamp: 1 }],
  });

function sse(events: Record<string, unknown>[]) {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function events(tool = false) {
  const item = tool
    ? {
        type: "function_call",
        id: "fc_test",
        call_id: "call_test",
        name: "synthetic_tool",
        arguments: '{"n":42}',
      }
    : {
        type: "message",
        id: "msg_test",
        role: "assistant",
        content: [{ type: "output_text", text: "42", annotations: [] }],
      };
  return [
    { type: "response.created", response: { id: "resp_test" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, ...(tool ? { arguments: "" } : { content: [] }) },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 100,
          output_tokens: 12,
          total_tokens: 112,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    },
  ];
}

async function fixture(t: test.TestContext, provider: ProviderId) {
  const dir = await mkdtemp(join(tmpdir(), "boc-wire-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialFile = join(dir, "oauth.json");
  await writeFile(
    credentialFile,
    JSON.stringify({
      type: "oauth",
      access: syntheticToken,
      refresh: "synthetic-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "synthetic-account",
      availableModelIds: [modelId],
    }),
    { mode: 0o600 },
  );
  const config = parseConfig({
    version: 1,
    event: { year: 2025 },
    storageDir: join(dir, "var"),
    aoc: { sessionCookieFile: join(dir, "absent-cookie") },
    creditPools: [
      {
        id: "pool",
        provider,
        unit: "synthetic-credit",
        limits: { event: "100", perPuzzle: "100" },
      },
    ],
    subscriptions: [
      {
        id: "wire",
        provider,
        credentialFile,
        model: modelId,
        creditPool: "pool",
        limits: { event: "100", perPuzzle: "100" },
        estimate: {
          pricing: "synthetic-wire",
          rates: { input: "2", output: "10", cacheRead: "0.1", cacheWrite: "2.5" },
          assumedMaxOutputTokens: 512,
        },
      },
    ],
  });
  const subscription = config.subscriptions[0];
  assert.ok(subscription);
  const adapter = await (provider === "github-copilot" ? createCopilotAdapter : createCodexAdapter)(
    subscription,
  );
  const requests: {
    url: URL;
    headers: Headers;
    body: Record<string, unknown>;
    signal: AbortSignal;
  }[] = [];
  const forbiddenUrls: string[] = [];
  let fetchAttempts = 0;
  let websocketAttempts = 0;
  // SDK error handlers may catch callback throws. Assert independently after
  // the SDK has finished so even a swallowed violation makes the test fail.
  t.after(() => assert.deepEqual(forbiddenUrls, [], "Unexpected outbound fetch attempt."));
  t.after(() => assert.equal(websocketAttempts, 0, "Unexpected WebSocket attempt."));
  t.after(() => assert.equal(fetchAttempts, requests.length, "Every fetch must be accounted for."));
  let respond: (request: Request) => Response | Promise<Response> = () => sse(events());
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    fetchAttempts++;
    const request = new Request(input, init);
    // A new auth/telemetry/discovery request is blocked, never a real fetch.
    const expected =
      provider === "github-copilot"
        ? "https://api.individual.githubcopilot.com/responses"
        : "https://chatgpt.com/backend-api/codex/responses";
    if (request.url !== expected) {
      forbiddenUrls.push(request.url);
      throw new Error("Unexpected outbound fetch blocked.");
    }
    const bytes = Buffer.from(await request.arrayBuffer());
    const json =
      request.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(bytes).toString()
        : bytes.toString();
    requests.push({
      url: new URL(request.url),
      headers: request.headers,
      body: JSON.parse(json),
      signal: request.signal,
    });
    return respond(request);
  });
  // Must be constructible: an arrow throws before its body can count `new`.
  function blockedWebSocket() {
    websocketAttempts++;
    throw new Error("WebSocket transport is forbidden.");
  }
  t.mock.method(globalThis, "WebSocket", blockedWebSocket);
  const order: string[] = [];
  const receipts: AssistantMessage[] = [];
  const charges: Awaited<ReturnType<typeof adapter.meter.actualCharge>>[] = [];
  assert.equal(adapter.outputCap, 512);
  assert.ok(adapter.outputCap);
  const streams = createGuardedStreams({
    model: adapter.model,
    transport: adapter.transport,
    outputCap: adapter.outputCap,
    admission: {
      reserve: async (request) => {
        order.push("reserve");
        assert.equal(request.options.maxRetries, 0);
        assert.equal(request.options.transport, "sse");
        assert.ok(request.options.maxTokens && request.options.maxTokens <= 512);
        const reserved = await adapter.meter.maxCharge(request);
        return {
          settle: async (message) => {
            charges.push(await adapter.meter.actualCharge(message, reserved));
            receipts.push(structuredClone(message));
            order.push("settle");
          },
          abandon: async () => {
            order.push("abandon");
          },
        };
      },
    },
  });
  return {
    adapter,
    requests,
    order,
    receipts,
    charges,
    streams,
    respond: (next: typeof respond) => {
      respond = next;
    },
  };
}

for (const provider of providers) {
  test(`${provider}: catalog retains sol and adds 6.1 with low reasoning and provider-specific limits`, () => {
    const catalog = (
      provider === "github-copilot" ? githubCopilotProvider : openaiCodexProvider
    )().getModels();
    for (const id of ["gpt-6-sol", modelId]) {
      const model = catalog.find((m) => m.id === id);
      assert.ok(model);
      assert.equal(model.type, "chat");
      assert.equal(model.provider, provider);
      assert.equal(
        model.api,
        provider === "github-copilot" ? "openai-responses" : "openai-codex-responses",
      );
      assert.equal(model.thinkingLevelMap?.low, "low");
      assert.equal(model.maxTokens, 128_000);
      if (id === modelId)
        assert.equal(model.contextWindow, provider === "github-copilot" ? 1_050_000 : 500_000);
    }
  });

  test(`${provider}: real SSE payload, output-cap behavior and native-credit usage derivation`, async (t) => {
    const f = await fixture(t, provider);
    let rewritten = false;
    const result = await f.streams
      .streamSimple(f.adapter.model, context(), {
        reasoning: "low",
        maxTokens: 128,
        onPayload: () => {
          rewritten = true;
          return { model: "forged" };
        },
        fetch: async () => assert.fail("Caller-supplied fetch must not reach the provider."),
        samplingParams: { max_output_tokens: 999_999 },
      })
      .result();
    assert.equal(rewritten, false);
    assert.equal(result.stopReason, "stop");
    assert.equal(f.requests.length, 1);
    const request = f.requests[0];
    assert.ok(request);
    assert.equal(request.body.stream, true);
    assert.equal(request.body.store, false);
    assert.equal(request.body.model, modelId);
    assert.deepEqual(request.body.reasoning, { effort: "low", summary: "auto" });
    if (provider === "github-copilot") assert.equal(request.body.max_output_tokens, 128);
    else {
      assert.equal(
        request.body.max_output_tokens,
        undefined,
        "Codex still ignores maxTokens: retain assumed output estimate",
      );
      assert.equal(request.headers.get("chatgpt-account-id"), "synthetic-account");
    }
    assert.deepEqual(f.order, ["reserve", "settle"]);
    assert.equal(result.usage.input, 70);
    assert.equal(
      result.usage.output,
      12,
      "reasoning is already included, not an extra billable output count",
    );
    assert.equal(result.usage.reasoning, 5);
    assert.equal(result.usage.cacheRead, 20);
    assert.equal(result.usage.cacheWrite, 10);
    assert.equal(f.charges[0]?.source, "derived");
    assert.equal(
      f.charges[0]?.credits,
      tokenCost(parseCredits("2"), 70) +
        tokenCost(parseCredits("10"), 12) +
        tokenCost(parseCredits("0.1"), 20) +
        tokenCost(parseCredits("2.5"), 10),
    );
  });

  test(`${provider}: missing SSE terminal usage is never treated as free`, async (t) => {
    const f = await fixture(t, provider);
    f.respond(() => sse(events().filter((e) => e.type !== "response.completed")));
    const result = await f.streams.streamSimple(f.adapter.model, context()).result();
    assert.equal(result.stopReason, "error");
    assert.equal(f.requests.length, 1);
    assert.equal(f.receipts[0]?.content[0]?.type, "text");
    assert.equal(f.charges[0]?.source, "estimated");
    assert.ok(f.charges[0] && f.charges[0].credits > 0n);
  });

  test(`${provider}: actual output truncation maps to length, not successful completion`, async (t) => {
    const f = await fixture(t, provider);
    f.respond(() =>
      sse(
        events().map((event) =>
          event.type === "response.completed"
            ? {
                ...event,
                type: "response.incomplete",
                response: {
                  ...event.response,
                  status: "incomplete",
                  incomplete_details: { reason: "max_output_tokens" },
                },
              }
            : event,
        ),
      ),
    );
    const result = await f.streams.streamSimple(f.adapter.model, context()).result();
    assert.equal(result.stopReason, "length");
    assert.equal(result.rawStopReason, "incomplete.max_output_tokens");
    assert.equal(f.requests.length, 1);
    assert.equal(f.charges[0]?.source, "derived");
  });

  test(`${provider}: actual SDK makes one HTTP request for 429/503/network errors`, async (t) => {
    const f = await fixture(t, provider);
    for (const status of [429, 503, "network"] as const) {
      f.respond(() => {
        if (status === "network") throw new TypeError("fetch failed: synthetic connection reset");
        return Response.json(
          { error: { message: "synthetic service unavailable", type: "server_error" } },
          { status, headers: { "retry-after": "0" } },
        );
      });
      const before = f.requests.length;
      const result = await f.streams.streamSimple(f.adapter.model, context()).result();
      assert.equal(result.stopReason, "error");
      assert.equal(
        f.requests.length - before,
        1,
        "no SDK retries, auth retries, or transport fallback",
      );
    }
  });

  test(`${provider}: actual tool-call round trip settles each generation before tool execution`, async (t) => {
    const f = await fixture(t, provider);
    f.respond(() => sse(events(f.requests.length === 1)));
    const agent = createSolverAgent({
      model: f.adapter.model,
      streams: f.streams,
      systemPrompt: "Synthetic tool test.",
      reasoning: "low",
      maxTurns: 2,
      tools: [
        {
          name: "synthetic_tool",
          label: "Synthetic",
          description: "Return a synthetic integer.",
          parameters: Type.Object({ n: Type.Integer() }),
          execute: async (_id, args) => {
            assert.deepEqual(f.order, ["reserve", "settle"]);
            assert.deepEqual(args, { n: 42 });
            f.order.push("tool");
            return { content: [{ type: "text", text: "synthetic-result-42" }], details: {} };
          },
        },
      ],
    });
    await agent.prompt("Use the tool, then answer.");
    await agent.waitForIdle();
    assert.deepEqual(f.order, ["reserve", "settle", "tool", "reserve", "settle"]);
    assert.equal(f.requests.length, 2);
    assert.match(
      JSON.stringify(f.requests[1]?.body.input),
      /function_call_output.*synthetic-result-42/,
    );
  });

  test(`${provider}: abort reaches actual fetch and retains the uncertain reservation`, async (t) => {
    const f = await fixture(t, provider);
    const abort = new AbortController();
    f.respond(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("synthetic abort", "AbortError")),
            { once: true },
          );
          abort.abort();
        }),
    );
    const result = await f.streams
      .streamSimple(f.adapter.model, context(), { signal: abort.signal })
      .result();
    assert.equal(result.stopReason, "aborted");
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]?.signal.aborted, true);
    assert.deepEqual(f.order, ["reserve", "abandon"]);
    assert.equal(f.charges.length, 0);
  });

  test(`${provider}: agent waits for async end listeners before becoming idle`, async (t) => {
    const f = await fixture(t, provider);
    const agent = createSolverAgent({
      model: f.adapter.model,
      streams: f.streams,
      systemPrompt: "Synthetic lifecycle.",
      tools: [],
      maxTurns: 1,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    agent.subscribe(async (event) => {
      if (event.type === "agent_end") {
        entered.resolve();
        await release.promise;
      }
    });
    let idle = false;
    const prompt = agent.prompt("Synthetic lifecycle.");
    const waiting = agent.waitForIdle().then(() => {
      idle = true;
    });
    try {
      await entered.promise;
      assert.equal(idle, false);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.order, ["reserve", "settle"]);
    } finally {
      release.resolve();
      await prompt;
      await waiting;
    }
    assert.equal(idle, true);
  });

  test(`${provider}: unfinished actual SSE tool calls cannot execute`, async (t) => {
    const f = await fixture(t, provider);
    // A terminal response without output_item.done must not execute partial args.
    f.respond(() => sse(events(true).filter((e) => e.type !== "response.output_item.done")));
    let executions = 0;
    const agent = createSolverAgent({
      model: f.adapter.model,
      streams: f.streams,
      systemPrompt: "Synthetic malformed stream.",
      maxTurns: 1,
      tools: [
        {
          name: "synthetic_tool",
          label: "Synthetic",
          description: "Never runs.",
          parameters: Type.Object({ n: Type.Integer() }),
          execute: async () => {
            executions++;
            return { content: [{ type: "text", text: "unexpected" }], details: {} };
          },
        },
      ],
    });
    await agent.prompt("Synthetic malformed tool call.");
    assert.equal(executions, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(f.receipts[0]?.stopReason, "error");
  });
}
