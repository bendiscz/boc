import type { Provider } from "../config.ts";

export interface ProviderReadiness {
  provider: Provider;
  eligible: false;
  reason: string;
}

// Deliberately no configuration switch to turn these into eligible adapters.
// Authentication and user-supplied credit rates are not proof of a safe upper bound.
export function providerReadiness(provider: Provider): ProviderReadiness {
  return {
    provider,
    eligible: false,
    reason:
      "Live execution disabled: authoritative credit accounting and a conservative per-call bound are not validated.",
  };
}
