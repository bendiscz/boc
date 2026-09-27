import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type BocConfig, ConfigError, loadConfig, parseConfig } from "../src/config.ts";

const example = JSON.parse(
  await readFile(new URL("../examples/boc.config.json", import.meta.url), "utf8"),
) as BocConfig;

function fixture(): BocConfig {
  return structuredClone(example);
}

test("example config validates without credentials or enabled adapters", () => {
  assert.deepEqual(parseConfig(fixture()), example);
});

test("rejects unknown fields, versions, and inline credentials without echoing them", () => {
  for (const input of [
    { ...fixture(), version: 2 },
    { ...fixture(), secretSentinel: "private-value" },
    { ...fixture(), aoc: { sessionCookieFile: "file", sessionCookie: "private-value" } },
    { ...fixture(), event: { year: 2014 } },
    { ...fixture(), event: { year: 2026.5 } },
  ]) {
    assert.throws(
      () => parseConfig(input),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.doesNotMatch(error.message, /private-value|secretSentinel/);
        return true;
      },
    );
  }
});

test("rejects invalid credits in all four limit locations without refinement exceptions", () => {
  for (const value of [1, -1, "-1", "01", "1e3", "1\n", "0.0000000000000000001", null]) {
    for (const collection of ["creditPools", "subscriptions"] as const) {
      for (const limit of ["event", "perPuzzle"] as const) {
        const config = fixture();
        const target = config[collection][0];
        assert.ok(target);
        const input = {
          ...config,
          [collection]: [
            { ...target, limits: { ...target.limits, [limit]: value } },
            ...config[collection].slice(1),
          ],
        };
        assert.throws(() => parseConfig(input), ConfigError);
      }
    }
  }
});

test("zero is a valid stop allocation; per-puzzle limits must fit event limits", () => {
  const config = fixture();
  for (const scope of [...config.creditPools, ...config.subscriptions]) {
    scope.limits = { event: "0", perPuzzle: "0" };
  }
  assert.doesNotThrow(() => parseConfig(config));
  const pool = config.creditPools[0];
  assert.ok(pool);
  pool.limits.perPuzzle = "0.000000000000000001";
  assert.throws(() => parseConfig(config), ConfigError);
});

test("rejects duplicate identities and duplicate credential files", () => {
  const config = fixture();
  const pool = config.creditPools[0];
  const subscription = config.subscriptions[0];
  assert.ok(pool && subscription);
  assert.throws(
    () => parseConfig({ ...config, creditPools: [...config.creditPools, pool] }),
    ConfigError,
  );
  assert.throws(
    () => parseConfig({ ...config, subscriptions: [...config.subscriptions, subscription] }),
    ConfigError,
  );
  assert.throws(
    () =>
      parseConfig({
        ...config,
        subscriptions: [...config.subscriptions, { ...subscription, id: "another" }],
      }),
    ConfigError,
  );
});

test("rejects missing or cross-provider pools and unused pools", () => {
  for (const creditPool of ["missing", "codex-pool"]) {
    const config = fixture();
    const subscription = config.subscriptions[0];
    assert.ok(subscription);
    subscription.creditPool = creditPool;
    assert.throws(() => parseConfig(config), ConfigError);
  }
  const config = fixture();
  const pool = config.creditPools[0];
  assert.ok(pool);
  config.creditPools.push({ ...pool, id: "unused" });
  assert.throws(() => parseConfig(config), ConfigError);
});

test("separate subscriptions can share a provider's aggregate pool", () => {
  const config = fixture();
  const subscription = config.subscriptions[0];
  assert.ok(subscription);
  config.subscriptions.push({
    ...subscription,
    id: "copilot-second",
    credentialFile: "../.secrets/second.json",
  });
  assert.doesNotThrow(() => parseConfig(config));
});

test("rejects shell-style paths and control characters", () => {
  for (const storageDir of [
    "",
    " ~/private",
    "~/private",
    "!cat secret",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal interpolation must be rejected.
    "${HOME}/private",
    "var\u0000",
    "var\n",
  ]) {
    assert.throws(() => parseConfig({ ...fixture(), storageDir }), ConfigError);
  }
});

test("resolves paths relative to config and never requires credential files to exist", async () => {
  const config = await loadConfig(
    fileURLToPath(new URL("../examples/boc.config.json", import.meta.url)),
  );
  assert.equal(config.storageDir, fileURLToPath(new URL("../var", import.meta.url)));
  assert.equal(
    config.aoc.sessionCookieFile,
    fileURLToPath(new URL("../.secrets/aoc-session", import.meta.url)),
  );
});

test("rejects credential aliases after path resolution", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "boc-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = fixture();
  const subscription = config.subscriptions[0];
  assert.ok(subscription);
  subscription.credentialFile = "./secret.json";
  config.subscriptions.push({ ...subscription, id: "duplicate", credentialFile: "secret.json" });
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(config));
  await assert.rejects(loadConfig(path), ConfigError);
});

test("malformed JSON and missing-file diagnostics do not disclose input", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "boc-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "private-path.json");
  await writeFile(path, '{"private-sentinel": BAD');
  for (const candidate of [path, join(dir, "private-missing")]) {
    await assert.rejects(loadConfig(candidate), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.doesNotMatch(error.message, /private-|BAD/);
      return true;
    });
  }
});
