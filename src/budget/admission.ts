import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Admission, AdmissionRequest, Reservation } from "../pi/guarded-streams.ts";
import type { PuzzleId } from "../state/ids.ts";
import type { Credits } from "./credits.ts";
import type { CreditLedger } from "./ledger.ts";

/**
 * Provider-specific credit semantics. No production meter exists yet: both real
 * providers are ineligible until a certified bound and authoritative receipts exist.
 */
export interface CreditMeter {
  /**
   * Certified conservative upper bound (native units) for exactly this request,
   * covering all billable work it can trigger. Throw if no safe bound exists.
   */
  maxCharge(request: AdmissionRequest): Credits;
  /**
   * Authoritative debit for a terminal message, with a receipt reference (not free
   * text). Throw if unavailable; the reservation then stays held.
   */
  actualCharge(message: AssistantMessage): Promise<{ credits: Credits; receipt: string }>;
}

export interface LedgerAdmissionOptions {
  readonly ledger: CreditLedger;
  readonly subscription: string;
  /** Exact model ID the subscription is configured for. */
  readonly model: string;
  readonly puzzle: PuzzleId;
  readonly meter: CreditMeter;
  /** Accounting label for the operation, e.g. "solve". */
  readonly operation?: string;
}

/** Admission for one subscription and puzzle scope, backed by the durable ledger. */
export function createLedgerAdmission(options: LedgerAdmissionOptions): Admission {
  return {
    async reserve(request: AdmissionRequest): Promise<Reservation> {
      if (request.model.id !== options.model) throw new Error("Model is not configured.");
      // Throws (denies) if the meter cannot establish a bound.
      const amount = options.meter.maxCharge(request);
      request.signal?.throwIfAborted();
      await options.ledger.reserve({
        id: request.id,
        subscription: options.subscription,
        puzzle: options.puzzle,
        amount,
        operation: options.operation ?? "model-call",
      });
      let used = false;
      return {
        async settle(message: AssistantMessage): Promise<void> {
          if (used) throw new Error("Reservation already settled.");
          used = true;
          let charge: { credits: Credits; receipt: string };
          try {
            charge = await options.meter.actualCharge(message);
          } catch {
            await options.ledger.markUncertain(request.id, "receipt-unavailable").catch(() => {});
            throw new Error("No authoritative receipt; reservation held.");
          }
          await options.ledger.settle(request.id, charge.credits, charge.receipt);
        },
        async abandon(reason): Promise<void> {
          if (used) return;
          used = true;
          // Annotation only; the reservation stays held until reconciled.
          await options.ledger.markUncertain(request.id, reason);
        },
      };
    },
  };
}
