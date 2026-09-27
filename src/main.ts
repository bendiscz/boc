#!/usr/bin/env node
import { runCli } from "./cli.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  out: (message) => console.log(message),
  err: (message) => console.error(message),
});
