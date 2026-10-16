import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { BocConfig } from "../config.ts";
import type { AdmissionRequest } from "../pi/guarded-streams.ts";
import type { CreditMeter } from "./admission.ts";
import {
  addCredits,
  type Credits,
  parseCredits,
  scaleCredits,
  tokenCost,
  ZERO_CREDITS,
} from "./credits.ts";
import type { ChargeSource } from "./ledger.ts";

/**
 * Best-effort credit estimation from token prices (D016). Estimates are padded by
 * a safety factor and err high; actual charges come from the provider when it
 * reports them, otherwise from reported token usage, otherwise the estimate.
 */

export interface Rates {
  readonly input: Credits;
  readonly output: Credits;
  readonly cacheRead: Credits;
  readonly cacheWrite: Credits;
}

export interface EstimateSettings {
  readonly pricing: string;
  readonly rates: Rates;
  readonly longContext?: { readonly inputTokensAbove: number; readonly rates: Rates };
  readonly safetyFactor: Credits;
  readonly assumedMaxOutputTokens: number;
}

export const DEFAULT_SAFETY_FACTOR = "1.5";
export const DEFAULT_ASSUMED_MAX_OUTPUT_TOKENS = 32_000;
/** Conservative characters per token for request text (typical tokenizers: ~4). */
const CHARS_PER_TOKEN = 3;
/** Fixed allowance for message framing and provider-side system text. */
const REQUEST_OVERHEAD_TOKENS = 1_000;

export function estimateSettings(
  subscription: BocConfig["subscriptions"][number],
): EstimateSettings | undefined {
  const estimate = subscription.estimate;
  if (!estimate) return undefined;
  const parseRates = (rates: NonNullable<typeof subscription.estimate>["rates"]): Rates => ({
    input: parseCredits(rates.input),
    output: parseCredits(rates.output),
    cacheRead: parseCredits(rates.cacheRead),
    cacheWrite: parseCredits(rates.cacheWrite),
  });
  return {
    pricing: estimate.pricing,
    rates: parseRates(estimate.rates),
    ...(estimate.longContext
      ? {
          longContext: {
            inputTokensAbove: estimate.longContext.inputTokensAbove,
            rates: parseRates(estimate.longContext.rates),
          },
        }
      : {}),
    safetyFactor: parseCredits(estimate.safetyFactor ?? DEFAULT_SAFETY_FACTOR),
    assumedMaxOutputTokens: estimate.assumedMaxOutputTokens ?? DEFAULT_ASSUMED_MAX_OUTPUT_TOKENS,
  };
}

export function estimateInputTokens(request: Pick<AdmissionRequest, "context">): number {
  const bytes = Buffer.byteLength(JSON.stringify(request.context), "utf8");
  return Math.ceil(bytes / CHARS_PER_TOKEN) + REQUEST_OVERHEAD_TOKENS;
}

function partialOutputTokens(partial: AssistantMessage): number {
  let chars = 0;
  for (const block of partial.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else if (block.type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface EstimatingMeterOptions {
  readonly settings: EstimateSettings;
  /**
   * True only if the provider enforces the request's output-token limit. Otherwise
   * the configured assumed maximum is used (e.g. Codex ignores maxTokens).
   */
  readonly enforcesMaxTokens: boolean;
  /** Provider-reported native charge, when the adapter can obtain one. */
  readonly providerCharge?: (
    message: AssistantMessage,
  ) => Promise<{ credits: Credits; receipt: string } | undefined>;
}

/** Rates used for reservations/cutoffs, independent of uncertain input-token estimates. */
export function reservationRates(settings: EstimateSettings): Rates {
  const tiers = [settings.rates, ...(settings.longContext ? [settings.longContext.rates] : [])];
  if (tiers.some((r) => r.input <= 0n || r.output <= 0n)) {
    throw new Error("No usable estimate (unknown or zero input/output rates).");
  }
  const max = (key: keyof Rates) => tiers.map((r) => r[key]).reduce((a, b) => (a > b ? a : b));
  return {
    input: max("input"),
    output: max("output"),
    cacheRead: max("cacheRead"),
    cacheWrite: max("cacheWrite"),
  };
}

export function createEstimatingMeter(options: EstimatingMeterOptions): CreditMeter {
  const { safetyFactor, assumedMaxOutputTokens, longContext } = options.settings;
  const worst = reservationRates(options.settings);
  // Price all input at the highest potentially applicable input/cache rate.
  const inputRate = [worst.input, worst.cacheRead, worst.cacheWrite].reduce((a, b) =>
    a > b ? a : b,
  );
  const outputLimit = (request: AdmissionRequest): number => {
    if (!options.enforcesMaxTokens) return assumedMaxOutputTokens;
    const requested = request.options.maxTokens ?? request.model.maxTokens;
    return Math.max(1, Math.min(requested, request.model.maxTokens || requested));
  };
  const inputCost = (request: AdmissionRequest) =>
    tokenCost(inputRate, estimateInputTokens(request));
  return {
    maxCharge(request) {
      const raw = addCredits(inputCost(request), tokenCost(worst.output, outputLimit(request)));
      const padded = scaleCredits(raw, safetyFactor);
      if (padded <= 0n) throw new Error("No usable estimate (zero rates).");
      return padded;
    },
    partialCharge(partial, request) {
      return addCredits(inputCost(request), tokenCost(worst.output, partialOutputTokens(partial)));
    },
    async actualCharge(message, reserved) {
      const reported = await options.providerCharge?.(message);
      if (reported) return { ...reported, source: "provider" as ChargeSource };
      const u = message.usage;
      if (u && u.input + u.output + u.cacheRead + u.cacheWrite > 0) {
        // Input includes all cache categories; reasoning is already in output.
        const rates =
          longContext && u.input + u.cacheRead + u.cacheWrite > longContext.inputTokensAbove
            ? longContext.rates
            : options.settings.rates;
        const credits = addCredits(
          tokenCost(rates.input, u.input),
          tokenCost(rates.output, u.output),
          tokenCost(rates.cacheRead, u.cacheRead),
          tokenCost(rates.cacheWrite, u.cacheWrite),
        );
        return {
          credits,
          receipt: `usage:${options.settings.pricing}:${u.input}/${u.output}/${u.cacheRead}/${u.cacheWrite}`,
          source: "derived" as ChargeSource,
        };
      }
      // A provider error before any output (e.g. HTTP 429/400) generates nothing
      // billable: best effort records zero, labelled as an estimate.
      if (message.stopReason === "error" && message.content.length === 0) {
        return {
          credits: ZERO_CREDITS,
          receipt: "error-before-output",
          source: "estimated" as ChargeSource,
        };
      }
      // No usage reported: keep the estimate as the charge (best effort, never zero).
      return {
        credits: reserved,
        receipt: `estimate:${options.settings.pricing}`,
        source: "estimated" as ChargeSource,
      };
    },
  };
}
