import { ConfigError, loadConfig } from "./config.ts";
import { providerReadiness } from "./providers/readiness.ts";

interface Output {
  out(message: string): void;
  err(message: string): void;
}

const HELP = `Bot of Code — offline foundation

Usage:
  boc check-config <file>   Validate configuration without reading credentials
  boc --help               Show this help

Live solving, provider requests, and AoC submissions are not enabled.`;

export async function runCli(args: string[], output: Output): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0] ?? ""))) {
    output.out(HELP);
    return 0;
  }
  if (args.length !== 2 || args[0] !== "check-config" || !args[1]) {
    output.err("Invalid command. Run boc --help.");
    return 2;
  }
  try {
    const config = await loadConfig(args[1]);
    output.out(
      "Configuration valid. Credential files were not read; provider access is unverified.",
    );
    for (const provider of new Set(
      config.subscriptions.map((subscription) => subscription.provider),
    )) {
      const readiness = providerReadiness(provider);
      output.out(`${readiness.provider}: ${readiness.reason}`);
    }
    return 0;
  } catch (error) {
    output.err(error instanceof ConfigError ? error.message : "Configuration check failed.");
    return 1;
  }
}
