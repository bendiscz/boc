import { AocError } from "./aoc/client.ts";
import { AppError, type Progress, runEvent } from "./app.ts";
import { ReplayError, renderReplayReport, replayEvent } from "./bench/replay.ts";
import { formatCredits, parseCredits } from "./budget/credits.ts";
import { CreditLedger, LedgerError } from "./budget/ledger.ts";
import { type BocConfig, ConfigError, loadConfig } from "./config.ts";
import { CALIBRATION_ADAPTERS } from "./providers/adapter.ts";
import { AdapterError } from "./providers/github-copilot.ts";
import { loginSubscription } from "./providers/login.ts";
import { providerReadiness } from "./providers/readiness.ts";
import { puzzleId } from "./state/ids.ts";
import { JournalError } from "./state/journal.ts";
import { layout } from "./state/layout.ts";
import { RunStore, StateError } from "./state/run-state.ts";
import { renderEventSummary, writeViews } from "./state/summary.ts";
import { createTerminalView } from "./ui/dashboard.ts";
import { PrivateFileError } from "./util/private-file.ts";

interface Output {
  out(message: string): void;
  err(message: string): void;
}

const HELP = `Bot of Code — offline foundation

Usage:
  boc check-config <config>        Validate configuration without reading credentials
  boc login <config> <subscription> [--browser]
                                   Authorize a subscription (device code, or --browser for
                                   Codex's browser sign-in with a localhost callback);
                                   writes only its credential file, never prints tokens
  boc calibration-report <config>  Compare estimates with recorded charges per subscription
  boc run <config> [--days 1,2,5] [--tui] [--calibrate]
                                   Solve puzzles (past days or waiting for releases);
                                   refuses to start without an eligible provider adapter;
                                   --calibrate (requires --days) uses uncalibrated adapters
  boc replay <config> --source <config> [--source <config>] --days 1,2
                                   Benchmark the config's model on days already solved in the
                                   sources: judged against their accepted answers, never
                                   contacting AoC; model calls are real and ledger-admitted
  boc status <config>              Show run state and credits (read-only, lock-free)
  boc views <config>               Regenerate private Markdown summaries from journals
  boc ledger settle <config> <reservation-id> <amount> <operator:receipt-ref>
                                   Record an authoritative charge for a held reservation
  boc ledger acknowledge <config> <reservation-id> <note>
                                   Acknowledge a reviewed credit overrun
  boc ledger break-lock <config>   Remove ledger and run-state locks left by a dead local process
  boc submission not-judged <config> <day> <part> <submission#> <note>
                                   Operator override: AoC never judged this submission
  boc --help                       Show this help

Ledger and submission commands need exclusive access: stop BoC first.
Calibrated providers: github-copilot, openai-codex. Others run only with --calibrate once implemented.`;

class UsageError extends Error {}

const VERSION = "0.1.0";

async function checkConfig(config: BocConfig, output: Output): Promise<void> {
  output.out("Configuration valid. Credential files were not read; provider access is unverified.");
  for (const provider of new Set(config.subscriptions.map((s) => s.provider))) {
    const readiness = providerReadiness(provider);
    output.out(`${readiness.provider}: ${readiness.reason}`);
  }
}

async function status(config: BocConfig, output: Output): Promise<void> {
  const paths = layout(config.storageDir, config.event.year);
  const state = await RunStore.inspect({ directory: paths.runs, eventYear: config.event.year });
  const ledger = await CreditLedger.inspect({ directory: paths.ledger, config });
  output.out(renderEventSummary(state, ledger).trimEnd());
}

async function views(config: BocConfig, output: Output): Promise<void> {
  const paths = layout(config.storageDir, config.event.year);
  const state = await RunStore.inspect({ directory: paths.runs, eventYear: config.event.year });
  const ledger = await CreditLedger.inspect({ directory: paths.ledger, config });
  await writeViews(paths, state, ledger);
  output.out("Private summaries regenerated.");
}

async function withLedger(config: BocConfig, action: (ledger: CreditLedger) => Promise<void>) {
  const ledger = await CreditLedger.open({
    directory: layout(config.storageDir, config.event.year).ledger,
    config,
  });
  try {
    await action(ledger);
  } finally {
    await ledger.close();
  }
}

async function ledgerCommand(args: string[], config: BocConfig, output: Output): Promise<void> {
  const [command, id, ...rest] = args;
  if (command === "break-lock" && id === undefined) {
    // Both journals of a dead local process; each is checked independently.
    const paths = layout(config.storageDir, config.event.year);
    await CreditLedger.breakStaleLock(paths.ledger);
    await RunStore.breakStaleLock(paths.runs);
    output.out("Stale ledger and run-state locks removed (if any).");
  } else if (command === "settle" && id && rest.length === 2) {
    const [amount = "", receipt = ""] = rest;
    if (!receipt.startsWith("operator:")) throw new UsageError();
    let credits: ReturnType<typeof parseCredits>;
    try {
      credits = parseCredits(amount);
    } catch {
      throw new UsageError();
    }
    await withLedger(config, (ledger) => ledger.settle(id, credits, receipt));
    output.out("Reservation settled.");
  } else if (command === "acknowledge" && id && rest.length === 1) {
    await withLedger(config, (ledger) => ledger.acknowledgeOverrun(id, rest[0] ?? ""));
    output.out("Overrun acknowledged.");
  } else {
    throw new UsageError();
  }
}

async function run(
  config: BocConfig,
  flags: string[],
  output: Output,
  runtime: Runtime,
): Promise<void> {
  let days: number[] | undefined;
  let tui = false;
  let calibrate = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--tui" && !tui) {
      tui = true;
    } else if (flag === "--calibrate" && !calibrate) {
      calibrate = true;
    } else if (
      flag === "--days" &&
      !days &&
      /^[0-9]{1,2}(,[0-9]{1,2}){0,30}$/.test(flags[i + 1] ?? "")
    ) {
      days = (flags[++i] ?? "").split(",").map(Number);
      if (days.some((day) => day < 1 || day > 31)) throw new UsageError();
    } else {
      throw new UsageError();
    }
  }
  // Calibration uses implemented-but-uncalibrated adapters, only for explicit past days.
  if (calibrate && !days) throw new UsageError();
  const view = tui && runtime.terminal ? createTerminalView(runtime.terminal) : undefined;
  const events: string[] = [];
  try {
    const results = await runEvent({
      config,
      version: VERSION,
      ...(days ? { days } : {}),
      ...(calibrate ? { adapters: CALIBRATION_ADAPTERS, pastOnly: true } : {}),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      onEvent: (message) => {
        if (!view) {
          output.out(`${new Date().toISOString()} ${message}`);
          return;
        }
        events.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
        if (events.length > 50) events.shift();
      },
      ...(view
        ? {
            onProgress: (progress: Progress) =>
              view.update({ ...progress, events, now: new Date() }),
          }
        : {}),
    });
    view?.close();
    for (const result of results) {
      output.out(`${result.puzzle}: part 1 ${result.part1}, part 2 ${result.part2 ?? "-"}`);
    }
  } catch (error) {
    view?.close();
    throw error;
  }
}

async function replay(config: BocConfig, flags: string[], output: Output, runtime: Runtime) {
  let days: number[] | undefined;
  const sourcePaths: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (flag === "--source" && value && !value.startsWith("--")) {
      sourcePaths.push(value);
      i++;
    } else if (flag === "--days" && !days && /^[0-9]{1,2}(,[0-9]{1,2}){0,30}$/.test(value ?? "")) {
      days = (value ?? "").split(",").map(Number);
      i++;
      if (days.some((day) => day < 1 || day > 31)) throw new UsageError();
    } else {
      throw new UsageError();
    }
  }
  if (!days || sourcePaths.length === 0) throw new UsageError();
  const sources: BocConfig[] = [];
  for (const path of sourcePaths) sources.push(await loadConfig(path));
  const report = await replayEvent({
    config,
    version: VERSION,
    sources,
    days,
    ...(runtime.signal ? { signal: runtime.signal } : {}),
    onEvent: (message) => output.out(`${new Date().toISOString()} ${message}`),
  });
  for (const line of renderReplayReport(report)) output.out(line);
}

async function submissionCommand(args: string[], config: BocConfig, output: Output) {
  const [command, day, part, submission, note] = args;
  if (
    command !== "not-judged" ||
    !/^[0-9]{1,2}$/.test(day ?? "") ||
    (part !== "1" && part !== "2") ||
    !/^[0-9]{1,3}$/.test(submission ?? "") ||
    !note ||
    args.length !== 5
  ) {
    throw new UsageError();
  }
  const paths = layout(config.storageDir, config.event.year);
  const store = await RunStore.open({ directory: paths.runs, eventYear: config.event.year });
  try {
    await store.record({
      type: "submission-not-judged",
      puzzle: puzzleId(Number(day)),
      part: Number(part) as 1 | 2,
      submission: Number(submission),
      note,
    });
  } finally {
    await store.close();
  }
  output.out(
    "Submission marked as not judged; a new attempt may propose and submit that answer again.",
  );
}

async function calibrationReport(config: BocConfig, output: Output): Promise<void> {
  const paths = layout(config.storageDir, config.event.year);
  const reports = await CreditLedger.report({ directory: paths.ledger, config });
  if (reports.length === 0) output.out("No model calls recorded.");
  for (const r of reports) {
    const unit =
      config.creditPools.find(
        (p) => p.id === config.subscriptions.find((s) => s.id === r.subscription)?.creditPool,
      )?.unit ?? "?";
    const sources = Object.entries(r.bySource)
      .map(([source, amount]) => `${source} ${formatCredits(amount as never)}`)
      .join(", ");
    output.out(
      `${r.subscription} [${unit}]: ${r.calls} calls (${r.settled} settled, ${r.held} held, ${r.uncertain} uncertain); estimated ${formatCredits(r.estimated)}, charged ${formatCredits(r.charged)} (${sources || "-"}); max actual/estimate ${r.maxRatio?.toFixed(3) ?? "-"}`,
    );
  }
  output.out(
    "Compare the charged totals with the provider's billing for the same period (FEASIBILITY.md, calibration protocol).",
  );
}

async function login(
  config: BocConfig,
  subscription: string,
  flags: string[],
  output: Output,
  runtime: Runtime,
) {
  if (flags.length > 1 || (flags.length === 1 && flags[0] !== "--browser")) throw new UsageError();
  if (!runtime.ask) throw new AppError("Login needs an interactive terminal.");
  const ask = runtime.ask;
  await loginSubscription(
    config,
    subscription,
    {
      ask,
      say: (message) => output.out(message),
      signal: runtime.signal ?? new AbortController().signal,
    },
    undefined,
    flags[0] === "--browser" ? "browser" : "device",
  );
}

interface Runtime {
  readonly signal?: AbortSignal;
  /** Interactive terminal for `--tui`; absent when not a TTY. */
  readonly terminal?: NodeJS.WriteStream;
  /** Line input for interactive login; absent when stdin is not a TTY. */
  readonly ask?: (question: string, signal?: AbortSignal) => Promise<string>;
}

export async function runCli(
  args: string[],
  output: Output,
  runtime: Runtime = {},
): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0] ?? ""))) {
    output.out(HELP);
    return 0;
  }
  const [command, ...rest] = args;
  const configIndex = command === "ledger" || command === "submission" ? 1 : 0;
  const isRun = command === "run" || command === "replay";
  const configPath = rest[configIndex];
  const known = [
    "check-config",
    "status",
    "views",
    "ledger",
    "run",
    "submission",
    "login",
    "calibration-report",
    "replay",
  ];
  if (!command || !known.includes(command) || !configPath) {
    output.err("Invalid command. Run boc --help.");
    return 2;
  }
  const argsOk = command === "login" ? rest.length === 2 || rest.length === 3 : rest.length === 1;
  if (command !== "ledger" && command !== "submission" && !isRun && !argsOk) {
    output.err("Invalid command. Run boc --help.");
    return 2;
  }
  let config: BocConfig;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    output.err(error instanceof ConfigError ? error.message : "Configuration check failed.");
    return 1;
  }
  try {
    if (command === "check-config") await checkConfig(config, output);
    else if (command === "status") await status(config, output);
    else if (command === "views") await views(config, output);
    else if (command === "replay") await replay(config, rest.slice(1), output, runtime);
    else if (isRun) await run(config, rest.slice(1), output, runtime);
    else if (command === "login")
      await login(config, rest[1] ?? "", rest.slice(2), output, runtime);
    else if (command === "calibration-report") await calibrationReport(config, output);
    else if (command === "submission") {
      await submissionCommand([rest[0] ?? "", ...rest.slice(2)], config, output);
    } else await ledgerCommand([rest[0] ?? "", ...rest.slice(2)], config, output);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      output.err("Invalid command. Run boc --help.");
      return 2;
    }
    // These error types carry fixed messages only (no paths, secrets, or content).
    if (runtime.signal?.aborted) {
      output.err("Stopped. State is saved; run again to resume.");
      return 130;
    }
    const safe =
      error instanceof LedgerError ||
      error instanceof JournalError ||
      error instanceof StateError ||
      error instanceof AppError ||
      error instanceof AocError ||
      error instanceof AdapterError ||
      error instanceof ReplayError ||
      error instanceof PrivateFileError;
    output.err(safe ? error.message : "Command failed.");
    return 1;
  }
}
