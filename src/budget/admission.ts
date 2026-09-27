import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Admission, AdmissionRequest, Reservation } from "../pi/guarded-streams.ts";
import type { PuzzleId } from "../state/ids.ts";
import type { Credits } from "./credits.ts";
import type { ChargeSource, CreditLedger } from "./ledger.ts";

/**
 * Provider-specific credit semantics. Under D016 limits are best effort: the
 * bound is a conservative estimate, not a guarantee.
 */
export interface CreditMeter {
  /**
   * Estimated maximum charge (native units) for exactly this request. Throw if no
   * estimate can be made (e.g. unknown rates): unknown costs are never zero.
   */
  maxCharge(request: AdmissionRequest): Credits;
  /**
   * Actual charge for a terminal message and how it was established. Throw only if
   * no charge can be stated at all; the reservation then stays held.
   */
  actualCharge(
    message: AssistantMessage,
    reserved: Credits,
  ): Promise<{ credits: Credits; receipt: string; source?: ChargeSource }>;
  /** Running cost estimate of a partial response, enabling the streaming cutoff. */
  partialCharge?(partial: AssistantMessage, request: AdmissionRequest): Credits;
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
          let charge: { credits: Credits; receipt: string; source?: ChargeSource };
          try {
            charge = await options.meter.actualCharge(message, amount);
          } catch {
            await options.ledger.markUncertain(request.id, "receipt-unavailable").catch(() => {});
            throw new Error("No authoritative receipt; reservation held.");
          }
          await options.ledger.settle(
            request.id,
            charge.credits,
            charge.receipt,
            charge.source ?? "provider",
          );
        },
        ...(options.meter.partialCharge
          ? {
              exceeds: (partial: AssistantMessage) =>
                (options.meter.partialCharge?.(partial, request) ?? 0n) > amount,
              settleCutoff: async (partial: AssistantMessage) => {
                if (used) throw new Error("Reservation already settled.");
                used = true;
                // Billed tokens up to the abort are unknown: record the larger of the
                // running estimate and the reservation (best effort, D016).
                const running = options.meter.partialCharge?.(partial, request) ?? amount;
                await options.ledger.settle(
                  request.id,
                  running > amount ? running : amount,
                  "cutoff:estimate",
                  "estimated",
                );
              },
            }
          : {}),
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
