import type { Provider } from "../config.ts";

export interface ProviderReadiness {
  provider: Provider;
  eligible: false;
  reason: string;
}

// Deliberately no configuration switch. Under D016 an adapter becomes usable once
// it exists in src/providers/, estimates per-call charges from configured rates,
// and has passed a supervised calibration run (docs/FEASIBILITY.md).
export function providerReadiness(provider: Provider): ProviderReadiness {
  return {
    provider,
    eligible: false,
    reason:
      "Live execution disabled: no calibrated adapter for this provider yet (best-effort limits, D016).",
  };
}
