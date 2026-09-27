import type { BocConfig } from "../config.ts";
import type { PuzzleId } from "../state/ids.ts";
import type { Credits } from "./credits.ts";
import type { LedgerStatus } from "./ledger.ts";

/**
 * Budget-aware subscription choice for the next attempt. Subscriptions are tried
 * in configuration order (operator preference). A subscription qualifies only if
 * its adapter is eligible and all four applicable counters still have at least
 * `minimum` credits in that pool's native unit. Selection is advisory: every call
 * is still admitted atomically by the ledger, so switching subscriptions can never
 * bypass a limit. Units from different pools are never compared or summed.
 */
export interface SelectionOptions {
  readonly config: BocConfig;
  /** `ledger.status([puzzle])`, so the puzzle's counters are present. */
  readonly ledger: LedgerStatus;
  readonly puzzle: PuzzleId;
  /** Adapter readiness (provider eligibility gates, credentials loaded, ...). */
  readonly eligible: (subscriptionId: string) => boolean;
  /** Smallest useful headroom for one attempt, in the subscription pool's unit. */
  readonly minimum: (subscriptionId: string) => Credits | undefined;
  /** Subscriptions to skip, e.g. after a provider fault this run. */
  readonly exclude?: ReadonlySet<string>;
}

export function selectSubscription(options: SelectionOptions): string | undefined {
  // A faulted ledger blocks all admission; excess overshoot blocks its pool.
  if (options.ledger.fault) return undefined;
  const blocked = new Set(options.ledger.overshoot.filter((o) => o.blocking).map((o) => o.pool));
  for (const subscription of options.config.subscriptions) {
    if (options.exclude?.has(subscription.id) || !options.eligible(subscription.id)) continue;
    if (blocked.has(subscription.creditPool)) continue;
    const minimum = options.minimum(subscription.id);
    // Unknown cost bound: not selectable (never treat unknown as zero).
    if (minimum === undefined || minimum <= 0n) continue;
    const relevant = options.ledger.counters.filter(
      (c) =>
        ((c.scope === "subscription" && c.id === subscription.id) ||
          (c.scope === "pool" && c.id === subscription.creditPool)) &&
        (c.period === "event" || c.period === options.puzzle),
    );
    const periods = new Set(relevant.map((c) => `${c.scope}/${c.period}`));
    // Puzzle counters appear once the puzzle is in the status; require all four.
    if (periods.size !== 4) continue;
    if (relevant.every((c) => !c.exceeded && c.remaining >= minimum)) return subscription.id;
  }
  return undefined;
}
