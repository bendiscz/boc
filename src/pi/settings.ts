import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** No ambient settings, automatic auxiliary calls, built-in tools, or telemetry. */
export function createOfflineSettings(): SettingsManager {
  return SettingsManager.inMemory({
    defaultTools: [],
    compaction: { enabled: false },
    branchSummary: { skipPrompt: true },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: "off",
    transport: "sse",
    enableInstallTelemetry: false,
    enableAnalytics: false,
    images: { blockImages: true },
  });
}

// This is a settings profile, NOT a sandbox or a budget gate. Do not create a live
// session until resources, credentials, tools, and every transport are constrained.
