import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Exercise the preflight's actual version predicate without running host checks,
// Docker, systemd, credential metadata probes or any live BoC process.
test("Pi preflight accepts the tested Node 26 line and Node 24 rollback, but rejects unsupported versions", async () => {
  const script = await readFile(new URL("../deploy/rpi/check.sh", import.meta.url), "utf8");
  const predicate = script.match(/if node -e '([^']+)'/u)?.[1];
  assert.ok(predicate, "Expected the offline preflight Node predicate.");
  for (const [version, supported] of [
    ["24.20.0", false],
    ["24.21.0", true],
    ["24.22.0", true],
    ["25.9.0", false],
    ["26.0.0", false],
    ["26.11.0", false],
    ["26.11.1", true],
    ["26.12.0", true],
    ["27.0.0", false],
  ] as const) {
    const child: SpawnSyncReturns<Buffer> = spawnSync(process.execPath, [
      "-e",
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} }); ${predicate}`,
    ]);
    assert.equal(child.status, supported ? 0 : 1, `${version}: ${child.stderr}`);
  }
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.node, ">=24.21.0 <25 || >=26.11.1 <27");
  assert.equal(
    (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim(),
    "26.11.1",
  );
});
