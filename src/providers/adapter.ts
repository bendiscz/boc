import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";
import type { CreditMeter } from "../budget/admission.ts";
import type { Credits } from "../budget/credits.ts";
import type { BocConfig } from "../config.ts";
import { createCopilotAdapter } from "./github-copilot.ts";
import { createCodexAdapter } from "./openai-codex.ts";

type Subscription = BocConfig["subscriptions"][number];

/**
 * A live provider integration. An adapter may exist only once its provider's
 * credit-accounting gate is satisfied (FEASIBILITY.md): a certified per-call
 * upper bound (`meter.maxCharge`), authoritative receipts (`meter.actualCharge`),
 * and a transport with no hidden retries or auxiliary calls.
 */
export interface ProviderAdapter {
  readonly model: Model<Api>;
  readonly transport: ProviderStreams;
  readonly meter: CreditMeter;
  /** Smallest useful headroom to start an attempt, in the pool's native unit. */
  readonly minimumAttemptCredits: Credits;
  /** Output-token cap enforced on every request (the meter's estimates assume it). */
  readonly outputCap?: number;
}

export type AdapterFactory = (subscription: Subscription) => Promise<ProviderAdapter | undefined>;

/**
 * Adapters implemented but not yet calibrated (D016). Usable only through
 * `boc run --calibrate --days …` (supervised past-puzzle runs); promoted to
 * PRODUCTION_ADAPTERS once FEASIBILITY.md records a passing calibration.
 */
export const CALIBRATION_ADAPTERS: Readonly<
  Partial<Record<Subscription["provider"], AdapterFactory>>
> = Object.freeze({
  "github-copilot": (subscription) => createCopilotAdapter(subscription),
  "openai-codex": (subscription) => createCodexAdapter(subscription),
});

/**
 * Production registry: adapters with a passing calibration recorded in
 * FEASIBILITY.md. There is no configuration switch to add one.
 * - github-copilot: calibrated 2026-09-27 (gpt-6-sol, 15 calls; see FEASIBILITY.md).
 * - openai-codex: calibrated 2026-09-27 (gpt-6-sol, 14 calls; token totals matched exactly).
 */
export const PRODUCTION_ADAPTERS: Readonly<
  Partial<Record<Subscription["provider"], AdapterFactory>>
> = Object.freeze({
  "github-copilot": (subscription) => createCopilotAdapter(subscription),
  "openai-codex": (subscription) => createCodexAdapter(subscription),
});
