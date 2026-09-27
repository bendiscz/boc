import {
  type Api,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type OAuthCredential,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { addCredits, scaleCredits, tokenCost } from "../budget/credits.ts";
import { createEstimatingMeter, estimateSettings } from "../budget/estimate.ts";
import type { BocConfig } from "../config.ts";
import { writeFileAtomic } from "../state/layout.ts";
import { readPrivateFile } from "../util/private-file.ts";
import type { ProviderAdapter } from "./adapter.ts";

/**
 * GitHub Copilot adapter (D016). Credentials come only from the subscription's
 * private credential file (written by `boc login`); no ambient environment,
 * auth.json, or Pi credential store is consulted. Streams go straight to Pi's
 * Copilot provider implementation with retries disabled by the guard, an
 * enforced output cap, and a per-request token refresh check.
 *
 * Findings (pi-ai 0.87.1, see FEASIBILITY.md): Copilot models use the
 * anthropic-messages, openai-completions, or openai-responses APIs; all three send
 * the output cap when `maxTokens` is set, create SDK clients with maxRetries 0,
 * and retry only via `options.maxRetries` (forced to 0). No per-call credit figure
 * is exposed, so charges are derived from reported token usage.
 */

type Subscription = BocConfig["subscriptions"][number];

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

/** Refresh when the Copilot token expires within this window. */
const REFRESH_MARGIN_MS = 2 * 60_000;

export interface CopilotAdapterOptions {
  /** Injected for tests; defaults to Pi's Copilot provider. */
  readonly provider?: Provider;
  readonly now?: () => number;
}

export function parseCopilotCredential(text: string): OAuthCredential {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AdapterError("Copilot credential file is not valid JSON; run boc login.");
  }
  const record = value as Record<string, unknown> | null;
  if (
    !record ||
    record.type !== "oauth" ||
    typeof record.refresh !== "string" ||
    typeof record.access !== "string" ||
    typeof record.expires !== "number"
  ) {
    throw new AdapterError("Copilot credential file is malformed; run boc login.");
  }
  return record as OAuthCredential;
}

export async function createCopilotAdapter(
  subscription: Subscription,
  options: CopilotAdapterOptions = {},
): Promise<ProviderAdapter> {
  if (subscription.provider !== "github-copilot")
    throw new AdapterError("Not a Copilot subscription.");
  const settings = estimateSettings(subscription);
  if (!settings) throw new AdapterError("Subscription has no estimate configured.");
  const provider = options.provider ?? githubCopilotProvider();
  const oauth = provider.auth.oauth;
  if (!oauth) throw new AdapterError("Copilot provider has no OAuth support.");
  const now = options.now ?? Date.now;
  const path = subscription.credentialFile;
  let credential = parseCopilotCredential(await readPrivateFile(path));
  const model = provider.getModels().find((m) => m.id === subscription.model) as
    | Model<Api>
    | undefined;
  if (!model) throw new AdapterError(`Model ${subscription.model} is not in the Copilot catalog.`);
  const available = credential.availableModelIds;
  if (Array.isArray(available) && !available.includes(model.id)) {
    throw new AdapterError(`Model ${model.id} is not enabled for this Copilot account.`);
  }

  let refreshing: Promise<OAuthCredential> | undefined;
  const fresh = async (signal: AbortSignal): Promise<OAuthCredential> => {
    if (credential.expires - now() > REFRESH_MARGIN_MS) return credential;
    refreshing ??= (async () => {
      try {
        // Pick up a credential renewed on disk (e.g. by `boc login`) before refreshing.
        const onDisk = parseCopilotCredential(await readPrivateFile(path));
        if (onDisk.expires - now() > REFRESH_MARGIN_MS) {
          credential = onDisk;
          return onDisk;
        }
        const next = await oauth.refresh(onDisk, signal);
        // Persist before use so a crash cannot lose a rotated credential.
        await writeFileAtomic(path, `${JSON.stringify(next)}\n`);
        credential = next;
        return next;
      } catch {
        throw new AdapterError("Copilot token refresh failed; run boc login if this persists.");
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  const dispatch = (
    requestModel: Model<Api>,
    context: TranscriptContext,
    streamOptions: SimpleStreamOptions | undefined,
  ): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const signal = streamOptions?.signal ?? new AbortController().signal;
      try {
        const current = await fresh(signal);
        const auth = await oauth.toAuth(current);
        if (!auth.apiKey) throw new AdapterError("Copilot credential has no access token.");
        const upstream = provider.streamSimple(
          { ...requestModel, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) },
          context,
          { ...streamOptions, apiKey: auth.apiKey, maxRetries: 0 },
        );
        for await (const event of upstream) output.push(event);
        output.end();
      } catch {
        // No request was answered: report a sanitized error terminal (never the token).
        output.push({
          type: "error",
          reason: signal.aborted ? "aborted" : "error",
          error: {
            role: "assistant",
            content: [],
            api: requestModel.api,
            provider: requestModel.provider,
            model: requestModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: signal.aborted ? "aborted" : "error",
            errorMessage: "Copilot request failed before a response.",
            timestamp: now(),
          },
        });
        output.end();
      }
    })();
    return output;
  };

  const transport: ProviderStreams = {
    stream: (m, c, o) => dispatch(m, c, o),
    streamSimple: (m, c, o) => dispatch(m, c, o),
  };
  const outputCap = Math.max(1, Math.min(settings.assumedMaxOutputTokens, model.maxTokens));
  const inputRate =
    settings.rates.cacheWrite > settings.rates.input
      ? settings.rates.cacheWrite
      : settings.rates.input;
  return {
    model: structuredClone(model),
    transport,
    meter: createEstimatingMeter({ settings, enforcesMaxTokens: true }),
    // One capped call on a small context must fit before an attempt starts.
    minimumAttemptCredits: scaleCredits(
      addCredits(tokenCost(inputRate, 8_000), tokenCost(settings.rates.output, outputCap)),
      settings.safetyFactor,
    ),
    outputCap,
  };
}
