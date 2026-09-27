import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";
import type { CreditMeter } from "../budget/admission.ts";
import type { Credits } from "../budget/credits.ts";
import type { BocConfig } from "../config.ts";

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
}

export type AdapterFactory = (subscription: Subscription) => Promise<ProviderAdapter | undefined>;

/**
 * Production registry. Deliberately empty: no provider has passed its gate, and
 * there is no configuration switch to add one. Tests inject fake factories.
 */
export const PRODUCTION_ADAPTERS: Readonly<
  Partial<Record<Subscription["provider"], AdapterFactory>>
> = Object.freeze({});
