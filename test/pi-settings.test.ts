import assert from "node:assert/strict";
import test from "node:test";
import { createOfflineSettings } from "../src/pi/settings.ts";

test("Pi settings disable automatic chargeable work and host tools", () => {
  const settings = createOfflineSettings();
  assert.deepEqual(settings.getDefaultTools(), []);
  assert.equal(settings.getCompactionSettings().enabled, false);
  assert.equal(settings.getBranchSummarySkipPrompt(), true);
  assert.equal(settings.getRetrySettings().enabled, false);
  assert.equal(settings.getProviderRetrySettings().maxRetries, 0);
  assert.equal(settings.getCacheWarmingMode(), "off");
  assert.equal(settings.getTransport(), "sse");
  assert.equal(settings.getEnableInstallTelemetry(), false);
  assert.equal(settings.getBlockImages(), true);
});

test("settings instances are isolated, not persistent global configuration", () => {
  const first = createOfflineSettings();
  first.setCompactionEnabled(true);
  assert.equal(createOfflineSettings().getCompactionSettings().enabled, false);
});
