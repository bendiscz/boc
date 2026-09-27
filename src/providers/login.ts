import type { AuthEvent, AuthPrompt, Provider } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import type { BocConfig } from "../config.ts";
import { writeFileAtomic } from "../state/layout.ts";
import { AdapterError } from "./github-copilot.ts";

/**
 * Minimal interactive authorization for one subscription. The operator completes
 * the provider's device flow in a browser; BoC writes the resulting credential
 * only to the subscription's configured credential file (0600) and never prints
 * tokens. Note: Pi's Copilot login also enables account models whose policy is
 * "unconfigured" (as VS Code does); models disabled by policy stay disabled.
 */

/** Provider error text is shown for diagnosis, bounded and with token-like strings removed. */
export function sanitizeLoginError(error: unknown): string {
  const text = error instanceof Error ? error.message : "unknown error";
  return text
    .replace(/\b(gh[opsu]|ghr|github_pat)_[A-Za-z0-9_]{10,}\b/g, "[redacted]")
    .replace(/\b(tid|exp|sku|proxy-ep)=[^\s;]*[^\s]*/g, "[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .split("")
    .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? " " : c))
    .join("")
    .slice(0, 200);
}

export interface LoginIo {
  ask(question: string): Promise<string>;
  say(message: string): void;
  readonly signal: AbortSignal;
}

export async function loginSubscription(
  config: BocConfig,
  subscriptionId: string,
  io: LoginIo,
  provider: Provider = githubCopilotProvider(),
): Promise<{ modelAvailable: boolean | undefined }> {
  const subscription = config.subscriptions.find((s) => s.id === subscriptionId);
  if (!subscription) throw new AdapterError("No such subscription.");
  if (subscription.provider !== "github-copilot") {
    throw new AdapterError("Interactive login is implemented only for github-copilot so far.");
  }
  const oauth = provider.auth.oauth;
  if (!oauth) throw new AdapterError("Provider has no OAuth login.");
  const credential = await oauth
    .login({
      signal: io.signal,
      prompt: async (prompt: AuthPrompt) => {
        if (prompt.type === "secret")
          throw new Error("Secret prompts are not supported; use files.");
        if (prompt.type === "select") throw new Error("Unsupported login prompt.");
        return io.ask(
          `${prompt.message}${prompt.placeholder ? ` (e.g. ${prompt.placeholder})` : ""}: `,
        );
      },
      notify: (event: AuthEvent) => {
        if (event.type === "device_code") {
          io.say(`Open ${event.verificationUri} and enter the code ${event.userCode}.`);
        } else if (event.type === "progress" || event.type === "info") {
          io.say(event.message);
        }
      },
    })
    .catch((error: unknown) => {
      throw new AdapterError(`Login failed: ${sanitizeLoginError(error)}`);
    });
  await writeFileAtomic(subscription.credentialFile, `${JSON.stringify(credential)}\n`);
  const available = credential.availableModelIds;
  const modelAvailable = Array.isArray(available)
    ? available.includes(subscription.model)
    : undefined;
  io.say(
    modelAvailable === false
      ? `Credential saved, but model ${subscription.model} is not enabled for this account.`
      : "Credential saved to the configured credential file.",
  );
  return { modelAvailable };
}
