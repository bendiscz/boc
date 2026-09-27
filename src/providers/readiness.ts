import type { Provider } from "../config.ts";

export interface ProviderReadiness {
  provider: Provider;
  eligible: boolean;
  reason: string;
}

// Deliberately no configuration switch. Under D016 an adapter becomes usable once
// it exists in src/providers/ and has passed a supervised calibration run recorded
// in docs/FEASIBILITY.md; it is then registered in PRODUCTION_ADAPTERS.
export function providerReadiness(provider: Provider): ProviderReadiness {
  if (provider === "github-copilot") {
    return {
      provider,
      eligible: true,
      reason:
        "Calibrated adapter (2026-09-27); limits are best effort (D016). Requires boc login and estimate rates.",
    };
  }
  return {
    provider,
    eligible: false,
    reason:
      "Live execution disabled: no calibrated adapter for this provider yet (best-effort limits, D016).",
  };
}
