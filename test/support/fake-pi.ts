import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type Models,
  type ProviderStreams,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  type ModelRuntime,
  SessionManager,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Admission, createGuardedStreams } from "../../src/pi/guarded-streams.ts";
import { createIsolatedResources } from "../../src/pi/resources.ts";
import { createOfflineSettings } from "../../src/pi/settings.ts";

export const FAKE_MODEL: Model<Api> = {
  id: "synthetic",
  name: "Synthetic offline model",
  provider: "boc-test",
  api: "boc-test",
  baseUrl: "https://boc.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 32000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Synthetic answer." }],
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

export function responseStream(response: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: response });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    stream.push({ type: "error", reason: response.stopReason, error: response });
  } else if (
    response.stopReason === "stop" ||
    response.stopReason === "length" ||
    response.stopReason === "toolUse"
  ) {
    stream.push({ type: "done", reason: response.stopReason, message: response });
  } else {
    throw new Error("Unsupported synthetic response.");
  }
  stream.end();
  return stream;
}

export function fakeRuntime(admission: Admission, transport: ProviderStreams) {
  let authCalls = 0;
  const guarded = createGuardedStreams({ model: FAKE_MODEL, admission, transport });
  const provider = createProvider({
    id: FAKE_MODEL.provider,
    models: [structuredClone(FAKE_MODEL)],
    auth: {
      apiKey: {
        name: "Synthetic auth (not a credential)",
        check: async () => ({ type: "api_key", source: "synthetic" }),
        resolve: async () => {
          authCalls++;
          return { auth: { apiKey: "synthetic-not-a-secret" } };
        },
      },
    },
    api: guarded,
  });
  const models = createModels({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    authContext: {
      env: async () => {
        throw new Error("Ambient auth must not be inspected.");
      },
      fileExists: async () => {
        throw new Error("Host auth files must not be inspected.");
      },
    },
  });
  models.setProvider(provider);

  // Provider-level check only: the guard itself is the model allowlist under test.
  function assertModel(candidate: string | Model<Api>) {
    const provider = typeof candidate === "string" ? candidate : candidate.provider;
    if (provider !== FAKE_MODEL.provider) throw new Error("Unknown synthetic provider.");
  }

  const stream: Models["stream"] = (model, context, options) => {
    assertModel(model);
    return models.stream(model, context, options);
  };
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    assertModel(model);
    return models.streamSimple(model, context, options);
  };
  const surface = {
    stream,
    streamSimple,
    complete: ((model, context, options) =>
      stream(model, context, options).result()) satisfies Models["complete"],
    completeSimple: ((model, context, options) =>
      streamSimple(model, context, options).result()) satisfies Models["completeSimple"],
    getModel: models.getModel.bind(models),
    getModels: models.getModels.bind(models),
    getProviders: models.getProviders.bind(models),
    getAvailableSnapshot: () => [structuredClone(FAKE_MODEL)],
    getAuth: ((input, options) => {
      assertModel(input);
      return typeof input === "string"
        ? models.getAuth(input, options)
        : models.getAuth(input, options);
    }) satisfies Models["getAuth"],
    checkAuth: ((input, options) => {
      assertModel(input);
      return models.checkAuth(input, options);
    }) satisfies Models["checkAuth"],
    hasConfiguredAuth: (id: string) => id === FAKE_MODEL.provider,
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    getError: () => undefined,
  };
  const facade = new Proxy(Object.freeze(surface), {
    get(target, key) {
      if (!Object.hasOwn(target, key)) throw new Error("Unsupported test runtime operation.");
      return Reflect.get(target, key);
    },
  });
  // TEST-ONLY bridge: Pi 0.87.1 requires its concrete, private-constructor runtime
  // rather than the supported Models interface. Never ship this cast as a live
  // integration. ModelRuntime.create would install built-ins/ambient auth instead.
  const runtime = facade as unknown as ModelRuntime;
  return { runtime, models, authCalls: () => authCalls };
}

export async function fakeSession(options: {
  cwd: string;
  admission: Admission;
  respond(context: TranscriptContext, options?: StreamOptions): AssistantMessage;
  tools?: ToolDefinition[];
  settings?: SettingsManager;
}) {
  const calls: TranscriptContext[] = [];
  const invoke: ProviderStreams["stream"] = (_model, context, requestOptions) => {
    calls.push(structuredClone(context));
    return responseStream(options.respond(context, requestOptions));
  };
  const fixture = fakeRuntime(options.admission, { stream: invoke, streamSimple: invoke });
  const settings = options.settings ?? createOfflineSettings();
  const resources = createIsolatedResources(
    "Solve only this synthetic test. No host instructions.",
  );
  const tools = options.tools ?? [];
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.cwd,
    model: structuredClone(FAKE_MODEL),
    modelRuntime: fixture.runtime,
    thinkingLevel: "off",
    scopedModels: [{ model: structuredClone(FAKE_MODEL), thinkingLevel: "off" }],
    resourceLoader: resources,
    noTools: "all",
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(options.cwd),
  });
  return { ...fixture, session, calls, settings, resources };
}
