// Opt-in probe of the production Docker executor. Not part of npm test or CI.
// Usage: npm run test:executor -- <local image ID sha256:...> (any image with node)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerExecutor } from "../src/sandbox/executor.ts";
import { Workspace } from "../src/sandbox/workspace.ts";

const image = process.argv[2];
if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) {
  throw new Error("Supply an existing local image ID (sha256:...) that contains node.");
}

process.env.BOC_EXECUTOR_CANARY = "synthetic-canary-not-a-secret";
const root = await mkdtemp(join(tmpdir(), "boc-executor-"));
try {
  const ws = await Workspace.create(join(root, "ws"));
  await ws.write(
    "probe.js",
    `
const fs = require('node:fs');
const os = require('node:os');
const out = {};
out.uid = process.getuid();
out.canary = process.env.BOC_EXECUTOR_CANARY ?? null;
try { fs.writeFileSync('/work/x', '1'); out.workWritable = true; } catch { out.workWritable = false; }
fs.mkdirSync('/tmp/home', { recursive: true });
fs.writeFileSync('/tmp/scratch', 'ok'); out.tmp = fs.readFileSync('/tmp/scratch', 'utf8');
out.external = Object.values(os.networkInterfaces()).flat().filter(n => !n.internal).length;
out.input = fs.readFileSync('/work/input.txt', 'utf8');
require('node:dns').promises.lookup('adventofcode.com')
  .then(() => { out.dns = true; }, () => { out.dns = false; })
  .then(() => fetch('https://1.1.1.1/', { signal: AbortSignal.timeout(5000) }))
  .then(() => { out.http = true; }, () => { out.http = false; })
  .then(() => console.log(JSON.stringify(out)));
`,
  );
  await ws.place("input.txt", "synthetic\n");
  const executor = createDockerExecutor({ image, maxOutputBytes: 4096 });
  const probe = await executor.run({
    workspace: ws.root,
    argv: ["node", "probe.js"],
    timeoutMs: 30_000,
  });
  assert.equal(probe.exitCode, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), {
    uid: 65534,
    canary: null,
    workWritable: false,
    tmp: "ok",
    external: 0,
    input: "synthetic\n",
    dns: false,
    http: false,
  });

  await ws.write("flood.js", "process.stdout.write('x'.repeat(100000));");
  const flood = await executor.run({
    workspace: ws.root,
    argv: ["node", "flood.js"],
    timeoutMs: 30_000,
  });
  assert.equal(flood.truncated, true);
  assert.equal(flood.stdout.length, 4096);

  await ws.write("spin.js", "for(;;){}");
  const spin = await executor.run({
    workspace: ws.root,
    argv: ["node", "spin.js"],
    timeoutMs: 2_000,
  });
  assert.equal(spin.timedOut, true);
  await new Promise((r) => setTimeout(r, 1_000));
  const leftovers = spawnSync("docker", ["ps", "-q", "--filter", "name=boc-"], {
    encoding: "utf8",
  });
  assert.equal(leftovers.stdout.trim(), "", "timed-out container was killed and removed");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_500);
  const aborted = await executor.run({
    workspace: ws.root,
    argv: ["node", "spin.js"],
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  assert.ok(aborted.durationMs < 15_000, "abort kills promptly");
  await new Promise((r) => setTimeout(r, 1_000));
  assert.equal(
    spawnSync("docker", ["ps", "-q", "--filter", "name=boc-"], { encoding: "utf8" }).stdout.trim(),
    "",
    "aborted container was removed",
  );
  if (process.argv.includes("--toolchains")) {
    await ws.write(
      "s.py",
      "import numpy, sympy, networkx, scipy\nprint(int(numpy.arange(4).sum()))\n",
    );
    // The letter-art decoder on synthetic glyphs drawn from its own font table.
    await ws.write(
      "ocr.py",
      "from advent_of_code_ocr import convert_6\nfrom advent_of_code_ocr.characters import ALPHABET_6\n" +
        "glyph = {v: k for k, v in ALPHABET_6.items()}\n" +
        "rows = ['.'.join(glyph[c].split('\\n')[r] for c in 'BOC') for r in range(6)]\n" +
        "print(convert_6('\\n'.join(rows)))\n",
    );
    await ws.write("m.go", 'package main\nimport "fmt"\nfunc main() { fmt.Println(6) }\n');
    await ws.write("m.rs", 'fn main() { println!("6"); }\n');
    await ws.write("m.mjs", "console.log(2 * 3);\n");
    await ws.write("c/Cargo.toml", '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n');
    await ws.write("c/src/main.rs", 'fn main() { println!("6"); }\n');
    const commands: string[][] = [
      ["python3", "s.py"],
      ["uv", "run", "--no-project", "s.py"],
      ["node", "m.mjs"],
      ["go", "run", "m.go"],
      ["sh", "-c", "rustc -O m.rs -o /tmp/m && /tmp/m"],
      // /work is read-only; Cargo needs a writable project for Cargo.lock.
      [
        "sh",
        "-c",
        "cp -r /work/c /tmp/c && cargo run -q --offline --manifest-path /tmp/c/Cargo.toml",
      ],
    ];
    for (const argv of commands) {
      const result = await executor.run({ workspace: ws.root, argv, timeoutMs: 120_000 });
      assert.equal(result.exitCode, 0, `${argv.join(" ")}: ${result.stderr}`);
      assert.equal(result.stdout.trim(), "6", argv.join(" "));
    }
    const ocr = await executor.run({
      workspace: ws.root,
      argv: ["python3", "ocr.py"],
      timeoutMs: 60_000,
    });
    assert.equal(ocr.exitCode, 0, `ocr.py: ${ocr.stderr}`);
    assert.equal(ocr.stdout.trim(), "BOC", "advent_of_code_ocr decodes its own glyphs");
    console.log(
      "Toolchains passed: python3 (numpy, scipy, sympy, networkx, advent_of_code_ocr), uv, node, go, rustc, cargo.",
    );
  }
  console.log(
    "Executor probe passed: non-root, no env leak, read-only /work, writable /tmp, no external network, bounded output, timeout kill.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
