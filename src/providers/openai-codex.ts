import type { Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { BocConfig } from "../config.ts";
import type { ProviderAdapter } from "./adapter.ts";
import { AdapterError, createOAuthAdapter } from "./oauth-adapter.ts";

/**
 * ChatGPT Business / Codex adapter (D016, D019). Uses the operator's own
 * "Sign in with ChatGPT" credential through pi-ai's Codex provider, which
 * identifies itself honestly (`originator: pi`, Pi's User-Agent).
 *
 * Findings (pi-ai 0.87.1, see FEASIBILITY.md): the Codex responses API does not
 * send an output-token limit, so estimates use `assumedMaxOutputTokens` and the
 * guard's streaming cutoff bounds runaway responses. Retries come only from
 * `options.maxRetries` (forced to 0) and the WebSocket path is skipped because
 * the guard forces SSE. Charges are derived from reported token usage at the
 * configured Codex credit rates.
 */

type Subscription = BocConfig["subscriptions"][number];

export interface CodexAdapterOptions {
  /** Injected for tests; defaults to Pi's Codex provider. */
  readonly provider?: Provider;
  readonly now?: () => number;
}

export function createCodexAdapter(
  subscription: Subscription,
  options: CodexAdapterOptions = {},
): Promise<ProviderAdapter> {
  if (subscription.provider !== "openai-codex") {
    return Promise.reject(new AdapterError("Not a Codex subscription."));
  }
  return createOAuthAdapter({
    subscription,
    provider: options.provider ?? openaiCodexProvider(),
    label: "Codex",
    enforcesMaxTokens: false,
    ...(options.now ? { now: options.now } : {}),
    checkCredential: (credential) => {
      if (typeof credential.accountId !== "string" || credential.accountId.length === 0) {
        throw new AdapterError("Codex credential has no ChatGPT account; run boc login.");
      }
    },
  });
}
