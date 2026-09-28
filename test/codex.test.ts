import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type Api,
  type Model,
  normalizeContext,
  type OAuthCredential,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { tokenCost } from "../src/budget/credits.ts";
import { parseConfig } from "../src/config.ts";
import { CALIBRATION_ADAPTERS, PRODUCTION_ADAPTERS } from "../src/providers/adapter.ts";
import { loginSubscription } from "../src/providers/login.ts";
import { createCodexAdapter } from "../src/providers/openai-codex.ts";
import { message, responseStream } from "./support/fake-pi.ts";

// Synthetic tokens only; no network.
const MODEL: Model<Api> = {
  id: "gpt-6-sol",
  name: "Synthetic",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  contextWindow: 272_000,
  maxTokens: 128_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function setup(t: test.TestContext, credential: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "boc-codex-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialFile = join(dir, "codex.json");
  await writeFile(
    credentialFile,
    JSON.stringify({
      type: "oauth",
      refresh: "synthetic-refresh",
      access: "synthetic-access",
      expires: Date.now() + 3_600_000,
      accountId: "synthetic-account",
      ...credential,
    }),
  );
  await chmod(credentialFile, 0o600);
  const config = parseConfig({
    version: 1,
    event: { year: 2025 },
    storageDir: join(dir, "var"),
    aoc: { sessionCookieFile: join(dir, "cookie") },
    creditPools: [
      {
        id: "codex-pool",
        provider: "openai-codex",
        unit: "codex-credit",
        limits: { event: "500", perPuzzle: "100" },
      },
    ],
    subscriptions: [
      {
        id: "codex",
        provider: "openai-codex",
        credentialFile,
        model: MODEL.id,
        creditPool: "codex-pool",
        limits: { event: "500", perPuzzle: "100" },
        estimate: {
          pricing: "codex-2026-09-27",
          rates: { input: "50", output: "250", cacheRead: "5", cacheWrite: "0" },
          assumedMaxOutputTokens: 16000,
        },
      },
    ],
  });
  const subscription = config.subscriptions[0];
  assert.ok(subscription);
  const calls: SimpleStreamOptions[] = [];
  const provider = {
    id: "openai-codex",
    name: "fake",
    getModels: () => [MODEL],
    auth: {
      oauth: {
        name: "fake",
        login: async () => assert.fail("not used"),
        refresh: async (c: OAuthCredential) => c,
        toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }),
      },
    },
    stream: () => assert.fail("native stream not used"),
    streamSimple: (_m: Model<Api>, _c: unknown, options?: SimpleStreamOptions) => {
      calls.push(options ?? {});
      return responseStream(message({ provider: "openai-codex", model: MODEL.id }));
    },
  } as unknown as Provider;
  return { config, subscription, credentialFile, provider, calls };
}

const request = () => ({
  id: "r",
  model: MODEL,
  context: normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 1 }] }),
  options: { maxTokens: 100 },
  signal: undefined,
});

test("Codex estimates assume the configured output maximum because the API ignores caps", async (t) => {
  const f = await setup(t);
  const adapter = await createCodexAdapter(f.subscription, { provider: f.provider });
  const estimate = adapter.meter.maxCharge(request());
  // Output priced at 16000 assumed tokens even though the request asked for 100.
  assert.ok(estimate > tokenCost((250n * 10n ** 18n) as never, 16_000));
  const result = await adapter.transport
    .streamSimple(adapter.model, request().context, {})
    .result();
  assert.equal(result.stopReason, "stop");
  assert.equal(f.calls[0]?.apiKey, "synthetic-access");
  assert.equal(f.calls[0]?.maxRetries, 0);
});

test("Codex credentials need a ChatGPT account; Codex is calibrated, Anthropic absent", async (t) => {
  const f = await setup(t, { accountId: undefined });
  await assert.rejects(
    createCodexAdapter(f.subscription, { provider: f.provider }),
    /no ChatGPT account/,
  );
  assert.ok(CALIBRATION_ADAPTERS["openai-codex"]);
  assert.ok(PRODUCTION_ADAPTERS["openai-codex"]);
  assert.equal(PRODUCTION_ADAPTERS.anthropic, undefined);
  assert.equal(CALIBRATION_ADAPTERS.anthropic, undefined);
});

test("the real Pi Codex catalog provides gpt-6-sol without network access", async (t) => {
  const f = await setup(t);
  const adapter = await createCodexAdapter(f.subscription);
  assert.equal(adapter.model.api, "openai-codex-responses");
  assert.equal(adapter.model.baseUrl, "https://chatgpt.com/backend-api");
});

test("Codex login picks the device-code flow; Anthropic login is refused", async (t) => {
  const f = await setup(t);
  const said: string[] = [];
  let selected = "";
  const provider = {
    ...f.provider,
    auth: {
      oauth: {
        name: "fake",
        login: async (i: {
          prompt: (p: unknown) => Promise<string>;
          notify: (e: unknown) => void;
        }) => {
          selected = await i.prompt({
            type: "select",
            message: "Select OpenAI Codex login method:",
            options: [
              { id: "browser", label: "Browser" },
              { id: "device_code", label: "Device code" },
            ],
          });
          i.notify({
            type: "device_code",
            userCode: "WXYZ-9876",
            verificationUri: "https://auth.openai.com/codex/device",
          });
          return {
            type: "oauth",
            refresh: "synthetic-r2",
            access: "synthetic-a2",
            expires: 1,
            accountId: "acct",
          };
        },
      },
    },
  } as unknown as Provider;
  const io = {
    ask: async () => "",
    say: (m: string) => said.push(m),
    signal: new AbortController().signal,
  };
  await loginSubscription(f.config, "codex", io, provider);
  assert.equal(selected, "device_code");
  assert.ok(said.some((m) => m.includes("WXYZ-9876")));
  assert.doesNotMatch(said.join(), /synthetic-/);
  assert.equal(JSON.parse(await readFile(f.credentialFile, "utf8")).accountId, "acct");

  const anthropic = parseConfig({
    ...f.config,
    creditPools: [
      { id: "a", provider: "anthropic", unit: "usd", limits: { event: "1", perPuzzle: "1" } },
    ],
    subscriptions: [
      {
        ...f.subscription,
        id: "claude",
        provider: "anthropic",
        creditPool: "a",
        limits: { event: "1", perPuzzle: "1" },
      },
    ],
  });
  await assert.rejects(loginSubscription(anthropic, "claude", io), /not supported for anthropic/);
});

test("browser login prints the sign-in URL and cancels the paste prompt when the callback arrives", async (t) => {
  const f = await setup(t);
  const said: string[] = [];
  let selected = "";
  let pasteAborted = false;
  const provider = {
    ...f.provider,
    auth: {
      oauth: {
        name: "fake",
        login: async (i: {
          prompt: (p: unknown) => Promise<string>;
          notify: (e: unknown) => void;
        }) => {
          selected = await i.prompt({
            type: "select",
            message: "method",
            options: [
              { id: "browser", label: "Browser" },
              { id: "device_code", label: "Device code" },
            ],
          });
          i.notify({
            type: "auth_url",
            url: "https://auth.openai.com/oauth/authorize?state=synthetic",
          });
          const manual = new AbortController();
          const pending = i
            .prompt({ type: "manual_code", message: "paste", signal: manual.signal })
            .catch(() => "aborted");
          manual.abort(); // the local callback server received the code
          assert.equal(await pending, "aborted");
          return {
            type: "oauth",
            refresh: "synthetic-r3",
            access: "synthetic-a3",
            expires: 1,
            accountId: "acct",
          };
        },
      },
    },
  } as unknown as Provider;
  const io = {
    ask: (_q: string, signal?: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          pasteAborted = true;
          reject(new Error("aborted"));
        });
      }),
    say: (m: string) => said.push(m),
    signal: new AbortController().signal,
  };
  await loginSubscription(f.config, "codex", io, provider, "browser");
  assert.equal(selected, "browser");
  assert.ok(pasteAborted);
  assert.ok(
    said.some((m) => m.includes("https://auth.openai.com/oauth/authorize?state=synthetic")),
  );
  assert.doesNotMatch(said.join(), /synthetic-[ar]3/);
});

test("the credential check forces a refresh, persists it, and reports failure safely", async (t) => {
  const f = await setup(t); // Access token valid for an hour: a normal request would not refresh.
  let refreshes = 0;
  let fail = false;
  const oauth = (f.provider.auth as { oauth: { refresh: unknown } }).oauth;
  oauth.refresh = async (c: OAuthCredential) => {
    refreshes++;
    if (fail) throw new Error("synthetic-secret refresh rejected");
    return { ...c, access: `synthetic-access-${refreshes}`, expires: Date.now() + 7_200_000 };
  };
  const adapter = await createCodexAdapter(f.subscription, { provider: f.provider });
  assert.ok(adapter.checkCredential);
  await adapter.checkCredential();
  assert.equal(refreshes, 1, "forced even though the token is still valid");
  const stored = JSON.parse(await readFile(f.credentialFile, "utf8")) as { access: string };
  assert.equal(stored.access, "synthetic-access-1", "the rotated credential is persisted");
  fail = true;
  await assert.rejects(adapter.checkCredential(), (error: Error) => {
    assert.match(error.message, /token refresh failed; run boc login/);
    assert.doesNotMatch(error.message, /synthetic-secret/);
    return true;
  });
});
