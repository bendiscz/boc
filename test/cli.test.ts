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
  assert.match(output.stdout.join("\n"), /Calibrated providers: github-copilot, openai-codex/);
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
  assert.equal(output.stdout.filter((line) => line.includes("Live execution disabled")).length, 1);
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

test("only calibrated providers are reported eligible", () => {
  assert.equal(providerReadiness("github-copilot").eligible, true);
  assert.equal(providerReadiness("openai-codex").eligible, true);
  assert.equal(providerReadiness("anthropic").eligible, false);
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
  const { mkdtemp, readFile, rm, stat, writeFile } = await import("node:fs/promises");
  const { hostname, tmpdir } = await import("node:os");
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
  // A run-state lock left by a dead process is removed too.
  const runLock = join(dir, "var/runs/2026/journal.lock");
  await writeFile(runLock, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), at: "x" }));
  output = capture();
  assert.equal(await runCli(["ledger", "break-lock", configPath], output), 0, output.stderr.join());
  await assert.rejects(stat(runLock), /ENOENT/);
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

test("the submission override command requires exact arguments and the store lock", async (t) => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RunStore } = await import("../src/state/run-state.ts");
  const dir = await mkdtemp(join(tmpdir(), "boc-cli-sub-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const example = JSON.parse(
    await readFile(new URL("../examples/boc.config.json", import.meta.url), "utf8"),
  );
  const configPath = join(dir, "boc.config.json");
  await writeFile(configPath, JSON.stringify({ ...example, storageDir: "var" }));
  const runs = join(dir, "var/runs/2026");
  const store = await RunStore.open({ directory: runs, eventYear: 2026 });
  const day = "day-01" as never;
  await store.record({ type: "input-fetched", puzzle: day, sha256: "a".repeat(64) });
  await store.record({ type: "statement-fetched", puzzle: day, part: 1, sha256: "b".repeat(64) });
  await store.record({
    type: "attempt-started",
    puzzle: day,
    part: 1,
    attempt: 1,
    subscription: "s",
  });
  await store.record({
    type: "attempt-finished",
    puzzle: day,
    part: 1,
    attempt: 1,
    outcome: "answer",
    answer: "5",
  });
  await store.record({
    type: "submission-started",
    puzzle: day,
    part: 1,
    submission: 1,
    attempt: 1,
    answer: "5",
  });
  await store.record({
    type: "submission-finished",
    puzzle: day,
    part: 1,
    submission: 1,
    verdict: "uncertain",
  });
  const args = ["submission", "not-judged", configPath, "1", "1", "1", "operator-checked"];
  let output = capture();
  assert.equal(await runCli(args, output), 1, "locked while the store is open");
  await store.close();
  output = capture();
  assert.equal(
    await runCli(["submission", "not-judged", configPath, "1", "3", "1", "x"], output),
    2,
  );
  output = capture();
  assert.equal(await runCli(args, output), 0, output.stderr.join());
  output = capture();
  assert.equal(await runCli(args, output), 1, "no longer overridable");
  const reopened = await RunStore.inspect({ directory: runs, eventYear: 2026 });
  assert.equal(reopened.puzzles["day-01"]?.parts[1].status, "ready");
});

test("calibration runs need explicit released days and an interactive login needs a terminal", async () => {
  const example = fileURLToPath(new URL("../examples/boc.config.json", import.meta.url));
  let output = capture();
  assert.equal(await runCli(["run", example, "--calibrate"], output), 2);
  output = capture();
  assert.equal(await runCli(["run", example, "--calibrate", "--days", "1"], output), 1);
  assert.match(output.stderr.join(), /limited to already released days/);
  output = capture();
  assert.equal(await runCli(["login", example, "copilot-work"], output), 1);
  assert.match(output.stderr.join(), /interactive terminal/);
  output = capture();
  assert.equal(await runCli(["calibration-report", example], output), 0);
  assert.match(output.stdout.join(), /No model calls recorded/);
});
