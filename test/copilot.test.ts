import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { parseCredits } from "../src/budget/credits.ts";
import { CreditLedger } from "../src/budget/ledger.ts";
import { parseConfig } from "../src/config.ts";
import { createGuardedStreams } from "../src/pi/guarded-streams.ts";
import { AdapterError, createCopilotAdapter } from "../src/providers/github-copilot.ts";
import { loginSubscription } from "../src/providers/login.ts";
import { PrivateFileError } from "../src/util/private-file.ts";
import { message, responseStream } from "./support/fake-pi.ts";

// Synthetic tokens only; no network. The fake provider stands in for Pi's Copilot provider.
const MODEL: Model<Api> = {
  id: "synthetic-copilot-model",
  name: "Synthetic",
  provider: "github-copilot",
  api: "anthropic-messages",
  baseUrl: "https://api.individual.githubcopilot.com",
  reasoning: false,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 16_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function setup(t: test.TestContext, credential: Partial<OAuthCredential> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "boc-copilot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialFile = join(dir, "copilot.json");
  const now = 1_000_000_000_000;
  await writeFile(
    credentialFile,
    JSON.stringify({
      type: "oauth",
      refresh: "synthetic-refresh",
      access: "synthetic-access-1",
      expires: now + 3_600_000,
      availableModelIds: [MODEL.id],
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
        id: "pool",
        provider: "github-copilot",
        unit: "ai-credit",
        limits: { event: "1000", perPuzzle: "100" },
      },
    ],
    subscriptions: [
      {
        id: "copilot",
        provider: "github-copilot",
        credentialFile,
        model: MODEL.id,
        creditPool: "pool",
        limits: { event: "1000", perPuzzle: "100" },
        estimate: {
          pricing: "synthetic",
          rates: { input: "300", output: "1500", cacheRead: "30", cacheWrite: "375" },
          assumedMaxOutputTokens: 8000,
        },
      },
    ],
  });
  const subscription = config.subscriptions[0];
  assert.ok(subscription);
  const calls: { model: Model<Api>; options: SimpleStreamOptions | undefined }[] = [];
  let refreshes = 0;
  let failRefresh = false;
  const provider = {
    id: "github-copilot",
    name: "fake",
    getModels: () => [MODEL],
    auth: {
      oauth: {
        name: "fake",
        login: async () => {
          throw new Error("not used");
        },
        refresh: async (c: OAuthCredential) => {
          refreshes++;
          await new Promise((r) => setTimeout(r, 5));
          if (failRefresh) throw new Error("synthetic-refresh-failure synthetic-refresh");
          return { ...c, access: `synthetic-access-${refreshes + 1}`, expires: now + 7_200_000 };
        },
        toAuth: async (c: OAuthCredential) => ({
          apiKey: c.access,
          baseUrl: "https://api.business.githubcopilot.com",
        }),
      },
    },
    stream: () => assert.fail("native stream not used"),
    streamSimple: (model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
      calls.push({ model, options });
      return responseStream(message({ provider: "github-copilot", model: model.id }));
    },
  } as unknown as Provider;
  let clock = now;
  const make = () => createCopilotAdapter(subscription, { provider, now: () => clock });
  return {
    dir,
    config,
    subscription,
    credentialFile,
    calls,
    make,
    provider,
    refreshes: () => refreshes,
    setFailRefresh: (v: boolean) => {
      failRefresh = v;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const context = () =>
  normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 1 }] });

test("the adapter uses only the credential file, token-derived endpoint, and a hard output cap", async (t) => {
  const f = await setup(t);
  const adapter = await f.make();
  assert.equal(adapter.outputCap, 8000);
  assert.ok(adapter.minimumAttemptCredits > 0n);
  const guard = createGuardedStreams({
    model: adapter.model,
    admission: { reserve: async () => ({ settle: async () => {} }) },
    transport: adapter.transport,
    ...(adapter.outputCap ? { outputCap: adapter.outputCap } : {}),
  });
  const result = await guard.streamSimple(adapter.model, context(), { maxTokens: 50_000 }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(f.calls.length, 1);
  const sent = f.calls[0];
  assert.equal(sent?.model.baseUrl, "https://api.business.githubcopilot.com");
  assert.equal(sent?.options?.apiKey, "synthetic-access-1");
  assert.equal(sent?.options?.maxTokens, 8000, "capped");
  assert.equal(sent?.options?.maxRetries, 0);
});

test("tokens near expiry are refreshed once, persisted privately, and failures are sanitized", async (t) => {
  const f = await setup(t);
  const adapter = await f.make();
  f.advance(3_600_000 - 60_000); // within the refresh margin
  await Promise.all([
    adapter.transport.streamSimple(adapter.model, context(), {}).result(),
    adapter.transport.streamSimple(adapter.model, context(), {}).result(),
  ]);
  assert.equal(f.refreshes(), 1, "concurrent requests share one refresh");
  assert.deepEqual(
    f.calls.map((c) => c.options?.apiKey),
    ["synthetic-access-2", "synthetic-access-2"],
  );
  const saved = JSON.parse(await readFile(f.credentialFile, "utf8"));
  assert.equal(saved.access, "synthetic-access-2");
  assert.equal((await stat(f.credentialFile)).mode & 0o077, 0);

  f.advance(7_200_000);
  f.setFailRefresh(true);
  const failed = await adapter.transport.streamSimple(adapter.model, context(), {}).result();
  assert.equal(failed.stopReason, "error");
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-refresh|synthetic-access/);
});

test("the adapter refuses unsafe files, missing estimates, and unavailable models", async (t) => {
  const f = await setup(t);
  await chmod(f.credentialFile, 0o644);
  await assert.rejects(f.make(), PrivateFileError);
  await chmod(f.credentialFile, 0o600);
  await writeFile(f.credentialFile, "{}");
  await assert.rejects(f.make(), /malformed/);
  const g = await setup(t, { availableModelIds: ["other-model"] });
  await assert.rejects(g.make(), /not enabled for this Copilot account/);
  const noEstimate = { ...g.subscription, estimate: undefined } as never;
  await assert.rejects(createCopilotAdapter(noEstimate, { provider: g.provider }), AdapterError);
  const unknown = { ...g.subscription, model: "missing-model" };
  await assert.rejects(
    createCopilotAdapter(unknown, { provider: g.provider }),
    /not in the Copilot catalog/,
  );
});

test("the real Pi Copilot catalog is used without network access at construction", async (t) => {
  const f = await setup(t, { availableModelIds: ["claude-sonnet-4.6"] });
  const adapter = await createCopilotAdapter({ ...f.subscription, model: "claude-sonnet-4.6" });
  assert.equal(adapter.model.provider, "github-copilot");
  assert.equal(adapter.model.api, "anthropic-messages");
  assert.ok(adapter.model.headers?.["Copilot-Integration-Id"]);
});

test("login writes only the configured credential file and never prints tokens", async (t) => {
  const f = await setup(t);
  const said: string[] = [];
  const provider = {
    ...f.provider,
    auth: {
      oauth: {
        name: "fake",
        login: async (interaction: {
          prompt: (p: unknown) => Promise<string>;
          notify: (e: unknown) => void;
        }) => {
          const domain = await interaction.prompt({
            type: "text",
            message: "Domain",
            placeholder: "x.ghe.com",
          });
          assert.equal(domain, "");
          interaction.notify({
            type: "device_code",
            userCode: "ABCD-1234",
            verificationUri: "https://github.com/login/device",
          });
          return {
            type: "oauth",
            refresh: "synthetic-new-refresh",
            access: "synthetic-new-access",
            expires: 1,
            availableModelIds: [MODEL.id],
          };
        },
      },
    },
  } as unknown as Provider;
  const result = await loginSubscription(
    f.config,
    "copilot",
    { ask: async () => "", say: (m) => said.push(m), signal: new AbortController().signal },
    provider,
  );
  assert.equal(result.modelAvailable, true);
  assert.ok(
    said.some((m) => m.includes("ABCD-1234") && m.includes("https://github.com/login/device")),
  );
  assert.doesNotMatch(said.join("\n"), /synthetic-new/);
  assert.equal(
    JSON.parse(await readFile(f.credentialFile, "utf8")).refresh,
    "synthetic-new-refresh",
  );
  assert.equal((await stat(f.credentialFile)).mode & 0o077, 0);
});

test("the calibration report compares estimates with charges by source", async (t) => {
  const f = await setup(t);
  const dir = join(f.dir, "ledger");
  const ledger = await CreditLedger.open({ directory: dir, config: f.config });
  const day = "day-01" as never;
  await ledger.reserve({
    id: "a",
    subscription: "copilot",
    puzzle: day,
    amount: parseCredits("10"),
    operation: "t",
  });
  await ledger.reserve({
    id: "b",
    subscription: "copilot",
    puzzle: day,
    amount: parseCredits("4"),
    operation: "t",
  });
  await ledger.reserve({
    id: "c",
    subscription: "copilot",
    puzzle: day,
    amount: parseCredits("4"),
    operation: "t",
  });
  await ledger.settle("a", parseCredits("3"), "usage:x:1/1/0/0", "derived");
  await ledger.settle("b", parseCredits("5"), "cutoff:estimate", "estimated");
  await ledger.close();
  const [report] = await CreditLedger.report({ directory: dir, config: f.config });
  assert.deepEqual(report, {
    subscription: "copilot",
    calls: 3,
    settled: 2,
    held: 1,
    uncertain: 0,
    estimated: parseCredits("14"),
    charged: parseCredits("8"),
    bySource: { derived: parseCredits("3"), estimated: parseCredits("5") },
    maxRatio: 1.25,
  });
});

test("a credential renewed on disk is picked up instead of refreshing a stale one", async (t) => {
  const f = await setup(t);
  const adapter = await f.make();
  f.advance(3_600_000);
  const renewed = {
    type: "oauth",
    refresh: "synthetic-refresh-b",
    access: "synthetic-access-disk",
    expires: 1_000_000_000_000 + 9_000_000,
  };
  await writeFile(f.credentialFile, JSON.stringify(renewed));
  await adapter.transport.streamSimple(adapter.model, context(), {}).result();
  assert.equal(f.refreshes(), 0);
  assert.equal(f.calls.at(-1)?.options?.apiKey, "synthetic-access-disk");
});

test("login failures are typed, informative, and never echo token-like strings", async (t) => {
  const f = await setup(t);
  const { sanitizeLoginError } = await import("../src/providers/login.ts");
  assert.equal(
    sanitizeLoginError(
      new Error("Device flow failed: access_denied token gho_abcdefghijklmnopqrstu tid=1;exp=2"),
    ),
    "Device flow failed: access_denied token [redacted] [redacted]",
  );
  const failing = {
    ...f.provider,
    auth: {
      oauth: {
        name: "x",
        login: async () => {
          throw new Error("401 Unauthorized: bad_verification_code");
        },
      },
    },
  } as unknown as Provider;
  const io = { ask: async () => "", say: () => {}, signal: new AbortController().signal };
  await assert.rejects(loginSubscription(f.config, "copilot", io, failing), (e) => {
    assert.ok(e instanceof AdapterError);
    assert.match(e.message, /Login failed: 401 Unauthorized: bad_verification_code/);
    return true;
  });
  await assert.rejects(loginSubscription(f.config, "nope", io, failing), /No such subscription/);
});
