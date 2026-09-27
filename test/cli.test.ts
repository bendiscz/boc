import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { providerReadiness } from "../src/providers/readiness.ts";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (value: string) => {
      stdout.push(value);
    },
    err: (value: string) => {
      stderr.push(value);
    },
  };
}

test("help works offline and explicitly reports the disabled live functionality", async () => {
  const output = capture();
  assert.equal(await runCli([], output), 0);
  assert.match(output.stdout.join("\n"), /not enabled/);
  assert.deepEqual(output.stderr, []);
});

test("valid config is not reported as ready for live solving", async () => {
  const output = capture();
  assert.equal(
    await runCli(
      ["check-config", fileURLToPath(new URL("../examples/boc.config.json", import.meta.url))],
      output,
    ),
    0,
  );
  assert.match(output.stdout.join("\n"), /Credential files were not read/);
  assert.equal(output.stdout.filter((line) => line.includes("Live execution disabled")).length, 2);
});

test("bad commands fail without echoing their potentially secret arguments", async () => {
  for (const args of [
    ["solve", "secret-sentinel"],
    ["check-config"],
    ["--help", "secret-sentinel"],
  ]) {
    const output = capture();
    assert.equal(await runCli(args, output), 2);
    assert.doesNotMatch(output.stderr.join("\n"), /secret-sentinel/);
  }
});

test("missing config is a sanitized operational error", async () => {
  const output = capture();
  assert.equal(await runCli(["check-config", "/does-not-exist/private-sentinel"], output), 1);
  assert.doesNotMatch(output.stderr.join("\n"), /private-sentinel/);
});

test("both real providers remain ineligible regardless of configured rates", () => {
  for (const provider of ["github-copilot", "openai-codex"] as const) {
    assert.equal(providerReadiness(provider).eligible, false);
  }
});

test("entry point runs without SDK discovery or credentials", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--help"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /offline foundation/);
});
