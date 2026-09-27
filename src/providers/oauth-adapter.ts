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
import { addCredits, scaleCredits, tokenCost } from "../budget/credits.ts";
import { createEstimatingMeter, estimateSettings } from "../budget/estimate.ts";
import type { BocConfig } from "../config.ts";
import { writeFileAtomic } from "../state/layout.ts";
import { readPrivateFile } from "../util/private-file.ts";
import type { ProviderAdapter } from "./adapter.ts";

/**
 * Generic adapter for OAuth-subscription providers served by pi-ai (D016). The
 * credential comes only from the subscription's private credential file (written
 * by `boc login`); no ambient environment, auth.json, or Pi credential store is
 * consulted. Streams go straight to the pi-ai provider implementation with
 * retries disabled by the guard, the output cap applied by the guard, and a
 * refresh check (re-reading the file first) before each request.
 */

type Subscription = BocConfig["subscriptions"][number];

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

/** Refresh when the access token expires within this window. */
const REFRESH_MARGIN_MS = 2 * 60_000;

export interface OAuthAdapterOptions {
  readonly subscription: Subscription;
  readonly provider: Provider;
  /** Display name for messages, e.g. "Copilot". */
  readonly label: string;
  /** True if the provider API enforces the requested output-token limit. */
  readonly enforcesMaxTokens: boolean;
  /** Provider-specific checks, e.g. account model availability. Throw AdapterError. */
  readonly checkCredential?: (credential: OAuthCredential, model: Model<Api>) => void;
  readonly now?: () => number;
}

export function parseOAuthCredential(text: string, label = "OAuth"): OAuthCredential {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AdapterError(`${label} credential file is not valid JSON; run boc login.`);
  }
  const record = value as Record<string, unknown> | null;
  if (
    !record ||
    record.type !== "oauth" ||
    typeof record.refresh !== "string" ||
    typeof record.access !== "string" ||
    typeof record.expires !== "number"
  ) {
    throw new AdapterError(`${label} credential file is malformed; run boc login.`);
  }
  return record as OAuthCredential;
}

export async function createOAuthAdapter(options: OAuthAdapterOptions): Promise<ProviderAdapter> {
  const { subscription, provider, label } = options;
  const settings = estimateSettings(subscription);
  if (!settings) throw new AdapterError("Subscription has no estimate configured.");
  if (settings.rates.input <= 0n || settings.rates.output <= 0n) {
    throw new AdapterError("Subscription estimate rates are not configured (zero).");
  }
  const oauth = provider.auth.oauth;
  if (!oauth) throw new AdapterError(`${label} provider has no OAuth support.`);
  const now = options.now ?? Date.now;
  const path = subscription.credentialFile;
  let credential = parseOAuthCredential(await readPrivateFile(path), label);
  const model = provider.getModels().find((m) => m.id === subscription.model) as
    | Model<Api>
    | undefined;
  if (!model) throw new AdapterError(`Model ${subscription.model} is not in the ${label} catalog.`);
  options.checkCredential?.(credential, model);

  let refreshing: Promise<OAuthCredential> | undefined;
  const fresh = async (signal: AbortSignal): Promise<OAuthCredential> => {
    if (credential.expires - now() > REFRESH_MARGIN_MS) return credential;
    refreshing ??= (async () => {
      try {
        // Pick up a credential renewed on disk (e.g. by `boc login`) before refreshing.
        const onDisk = parseOAuthCredential(await readPrivateFile(path), label);
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
        throw new AdapterError(`${label} token refresh failed; run boc login if this persists.`);
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
        if (!auth.apiKey) throw new AdapterError(`${label} credential has no access token.`);
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
            errorMessage: `${label} request failed before a response.`,
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
  // Where the provider ignores the cap, the guard still sends it and the streaming
  // cutoff plus the assumed maximum bound the estimate.
  const outputCap = Math.max(1, Math.min(settings.assumedMaxOutputTokens, model.maxTokens));
  const inputRate =
    settings.rates.cacheWrite > settings.rates.input
      ? settings.rates.cacheWrite
      : settings.rates.input;
  return {
    model: structuredClone(model),
    transport,
    meter: createEstimatingMeter({ settings, enforcesMaxTokens: options.enforcesMaxTokens }),
    // One capped call on a small context must fit before an attempt starts.
    minimumAttemptCredits: scaleCredits(
      addCredits(tokenCost(inputRate, 8_000), tokenCost(settings.rates.output, outputCap)),
      settings.safetyFactor,
    ),
    outputCap,
  };
}
