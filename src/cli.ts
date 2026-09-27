import { AocError } from "./aoc/client.ts";
import { AppError, type Progress, runEvent } from "./app.ts";
import { parseCredits } from "./budget/credits.ts";
import { CreditLedger, LedgerError } from "./budget/ledger.ts";
import { type BocConfig, ConfigError, loadConfig } from "./config.ts";
import { providerReadiness } from "./providers/readiness.ts";
import { puzzleId } from "./state/ids.ts";
import { JournalError } from "./state/journal.ts";
import { layout } from "./state/layout.ts";
import { RunStore, StateError } from "./state/run-state.ts";
import { renderEventSummary, writeViews } from "./state/summary.ts";
import { createTerminalView } from "./ui/dashboard.ts";

interface Output {
  out(message: string): void;
  err(message: string): void;
}

const HELP = `Bot of Code — offline foundation

Usage:
  boc check-config <config>        Validate configuration without reading credentials
  boc run <config> [--days 1,2,5] [--tui]
                                   Solve puzzles (past days or waiting for releases);
                                   refuses to start without an eligible provider adapter
  boc status <config>              Show run state and credits (read-only, lock-free)
  boc views <config>               Regenerate private Markdown summaries from journals
  boc ledger settle <config> <reservation-id> <amount> <operator:receipt-ref>
                                   Record an authoritative charge for a held reservation
  boc ledger acknowledge <config> <reservation-id> <note>
                                   Acknowledge a reviewed credit overrun
  boc ledger break-lock <config>   Remove a ledger lock left by a dead local process
  boc submission not-judged <config> <day> <part> <submission#> <note>
                                   Operator override: AoC never judged this submission
  boc --help                       Show this help

Ledger and submission commands need exclusive access: stop BoC first.
No provider adapter is eligible yet, so \`boc run\` currently always refuses to start.`;

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
    await CreditLedger.breakStaleLock(layout(config.storageDir, config.event.year).ledger);
    output.out("Stale ledger lock removed.");
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
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--tui" && !tui) {
      tui = true;
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
  const view = tui && runtime.terminal ? createTerminalView(runtime.terminal) : undefined;
  const events: string[] = [];
  try {
    const results = await runEvent({
      config,
      version: VERSION,
      ...(days ? { days } : {}),
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

interface Runtime {
  readonly signal?: AbortSignal;
  /** Interactive terminal for `--tui`; absent when not a TTY. */
  readonly terminal?: NodeJS.WriteStream;
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
  const isRun = command === "run";
  const configPath = rest[configIndex];
  const known = ["check-config", "status", "views", "ledger", "run", "submission"];
  if (!command || !known.includes(command) || !configPath) {
    output.err("Invalid command. Run boc --help.");
    return 2;
  }
  if (command !== "ledger" && command !== "submission" && !isRun && rest.length !== 1) {
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
    else if (isRun) await run(config, rest.slice(1), output, runtime);
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
      error instanceof AocError;
    output.err(safe ? error.message : "Command failed.");
    return 1;
  }
}
