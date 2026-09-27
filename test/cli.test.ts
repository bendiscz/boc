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
  assert.match(output.stdout.join("\n"), /always refuses to start/);
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

test("status is lock-free; ledger commands require exclusive access", async (t) => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { CreditLedger } = await import("../src/budget/ledger.ts");
  const { loadConfig } = await import("../src/config.ts");
  const { parseCredits } = await import("../src/budget/credits.ts");
  const { puzzleId } = await import("../src/state/ids.ts");
  const dir = await mkdtemp(join(tmpdir(), "boc-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const example = JSON.parse(
    await readFile(new URL("../examples/boc.config.json", import.meta.url), "utf8"),
  );
  const configPath = join(dir, "boc.config.json");
  await writeFile(configPath, JSON.stringify({ ...example, storageDir: "var" }));
  const config = await loadConfig(configPath);

  let output = capture();
  assert.equal(await runCli(["status", configPath], output), 0, output.stderr.join());
  assert.match(output.stdout.join("\n"), /No puzzles recorded yet/);

  const ledger = await CreditLedger.open({ directory: join(dir, "var/ledger/2026"), config });
  await ledger.reserve({
    id: "held-1",
    subscription: "copilot-work",
    puzzle: puzzleId(1),
    amount: parseCredits("5"),
    operation: "test",
  });
  output = capture();
  assert.equal(await runCli(["status", configPath], output), 0);
  assert.match(output.stdout.join("\n"), /held-1: 5 on copilot-work\/copilot-pool, day-01$/m);
  output = capture();
  const settle = ["ledger", "settle", configPath, "held-1", "2", "operator:invoice-7"];
  assert.equal(await runCli(settle, output), 1);
  assert.match(output.stderr.join(), /locked/i);
  await ledger.close();

  output = capture();
  assert.equal(
    await runCli(["ledger", "settle", configPath, "held-1", "2", "no-prefix"], output),
    2,
  );
  output = capture();
  assert.equal(await runCli(settle, output), 0, output.stderr.join());
  output = capture();
  assert.equal(await runCli(settle, output), 1, "already settled");
  assert.match(output.stderr.join(), /Invalid settlement/);

  output = capture();
  assert.equal(await runCli(["views", configPath], output), 0, output.stderr.join());
  assert.match(await readFile(join(dir, "var/runs/2026/SUMMARY.md"), "utf8"), /\| 2 \| 0 \| 98 \|/);
  assert.match(await readFile(join(dir, "var/INDEX.md"), "utf8"), /2026/);
  output = capture();
  assert.equal(await runCli(["ledger", "break-lock", configPath], output), 0);
});

test("run refuses to start without an eligible provider and validates day lists", async () => {
  const example = fileURLToPath(new URL("../examples/boc.config.json", import.meta.url));
  let output = capture();
  assert.equal(await runCli(["run", example], output), 1);
  assert.match(output.stderr.join(), /No eligible provider adapter/);
  for (const flags of [
    ["--days"],
    ["--days", "1;2"],
    ["--days", "1,2", "x"],
    ["--days", "0"],
    ["--days", "32"],
    ["--fast"],
  ]) {
    output = capture();
    assert.equal(await runCli(["run", example, ...flags], output), 2, flags.join(" "));
  }
});

test("an aborted run reports a resumable stop with exit code 130", async () => {
  const example = fileURLToPath(new URL("../examples/boc.config.json", import.meta.url));
  const controller = new AbortController();
  controller.abort();
  const output = capture();
  assert.equal(await runCli(["run", example], output, { signal: controller.signal }), 130);
  assert.match(output.stderr.join(), /State is saved/);
});

test("abortable sleep resolves, rejects on abort, and leaves no listeners", async () => {
  const { abortableSleep } = await import("../src/util/sleep.ts");
  const controller = new AbortController();
  const events = await import("node:events");
  await abortableSleep(1, controller.signal);
  assert.equal(events.EventEmitter.getEventListeners(controller.signal, "abort").length, 0);
  const pending = abortableSleep(10_000, controller.signal);
  controller.abort();
  await assert.rejects(pending);
});
