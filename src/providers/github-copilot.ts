import type { Provider } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import type { BocConfig } from "../config.ts";
import type { ProviderAdapter } from "./adapter.ts";
import { AdapterError, createOAuthAdapter } from "./oauth-adapter.ts";

export { AdapterError } from "./oauth-adapter.ts";

/**
 * GitHub Copilot adapter (D016; calibrated 2026-09-27).
 *
 * Findings (pi-ai 0.87.1, see FEASIBILITY.md): Copilot models use the
 * anthropic-messages, openai-completions, or openai-responses APIs; all three send
 * the output cap when `maxTokens` is set, create SDK clients with maxRetries 0,
 * and retry only via `options.maxRetries` (forced to 0). No per-call credit figure
 * is exposed, so charges are derived from reported token usage.
 */

type Subscription = BocConfig["subscriptions"][number];

export interface CopilotAdapterOptions {
  /** Injected for tests; defaults to Pi's Copilot provider. */
  readonly provider?: Provider;
  readonly now?: () => number;
}

export function createCopilotAdapter(
  subscription: Subscription,
  options: CopilotAdapterOptions = {},
): Promise<ProviderAdapter> {
  if (subscription.provider !== "github-copilot") {
    return Promise.reject(new AdapterError("Not a Copilot subscription."));
  }
  return createOAuthAdapter({
    subscription,
    provider: options.provider ?? githubCopilotProvider(),
    label: "Copilot",
    enforcesMaxTokens: true,
    ...(options.now ? { now: options.now } : {}),
    checkCredential: (credential, model) => {
      const available = credential.availableModelIds;
      if (Array.isArray(available) && !available.includes(model.id)) {
        throw new AdapterError(`Model ${model.id} is not enabled for this Copilot account.`);
      }
    },
  });
}
