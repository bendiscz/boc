#!/usr/bin/env node
import { runCli } from "./cli.ts";

// First Ctrl-C requests a graceful stop (journals stay consistent); a second one exits.
const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(130);
  console.error("Stopping after the current step... (Ctrl-C again to force)");
  controller.abort();
});
process.on("SIGTERM", () => controller.abort());

process.exitCode = await runCli(
  process.argv.slice(2),
  {
    out: (message) => console.log(message),
    err: (message) => console.error(message),
  },
  { signal: controller.signal, ...(process.stdout.isTTY ? { terminal: process.stdout } : {}) },
);
