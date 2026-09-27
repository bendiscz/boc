import { parseCredits } from "./budget/credits.ts";
import { CreditLedger, LedgerError } from "./budget/ledger.ts";
import { type BocConfig, ConfigError, loadConfig } from "./config.ts";
import { providerReadiness } from "./providers/readiness.ts";
import { JournalError } from "./state/journal.ts";
import { layout } from "./state/layout.ts";
import { RunStore, StateError } from "./state/run-state.ts";
import { renderEventSummary, writeViews } from "./state/summary.ts";

interface Output {
  out(message: string): void;
  err(message: string): void;
}

const HELP = `Bot of Code — offline foundation

Usage:
  boc check-config <config>        Validate configuration without reading credentials
  boc status <config>              Show run state and credits (read-only, lock-free)
  boc views <config>               Regenerate private Markdown summaries from journals
  boc ledger settle <config> <reservation-id> <amount> <operator:receipt-ref>
                                   Record an authoritative charge for a held reservation
  boc ledger acknowledge <config> <reservation-id> <note>
                                   Acknowledge a reviewed credit overrun
  boc ledger break-lock <config>   Remove a ledger lock left by a dead local process
  boc --help                       Show this help

Ledger commands need exclusive access: stop BoC first.
Live solving, provider requests, and AoC submissions are not enabled.`;

class UsageError extends Error {}

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

export async function runCli(args: string[], output: Output): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0] ?? ""))) {
    output.out(HELP);
    return 0;
  }
  const [command, ...rest] = args;
  const configIndex = command === "ledger" ? 1 : 0;
  const configPath = rest[configIndex];
  const known = ["check-config", "status", "views", "ledger"];
  if (!command || !known.includes(command) || !configPath) {
    output.err("Invalid command. Run boc --help.");
    return 2;
  }
  if (command !== "ledger" && rest.length !== 1) {
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
    else await ledgerCommand([rest[0] ?? "", ...rest.slice(2)], config, output);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      output.err("Invalid command. Run boc --help.");
      return 2;
    }
    // These error types carry fixed messages only (no paths, secrets, or content).
    const safe =
      error instanceof LedgerError || error instanceof JournalError || error instanceof StateError;
    output.err(safe ? error.message : "Command failed.");
    return 1;
  }
}
