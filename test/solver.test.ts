import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createLedgerAdmission } from "../src/budget/admission.ts";
import { parseCredits } from "../src/budget/credits.ts";
import { CreditLedger } from "../src/budget/ledger.ts";
import { parseConfig } from "../src/config.ts";
import { createGuardedStreams } from "../src/pi/guarded-streams.ts";
import {
  dockerArgs,
  dockerExecArgs,
  dockerSessionArgs,
  type Executor,
  type RunRequest,
  sanitize,
} from "../src/sandbox/executor.ts";
import { MAX_FILE_BYTES, Workspace } from "../src/sandbox/workspace.ts";
import { createSolverAgent } from "../src/solver/agent.ts";
import { createSolverTools } from "../src/solver/tools.ts";
import { puzzleId } from "../src/state/ids.ts";
import { FAKE_MODEL, message, responseStream } from "./support/fake-pi.ts";

async function tmp(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "boc-solver-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("workspace paths are confined, bounded, and never follow symlinks", async (t) => {
  const root = await tmp(t);
  const outside = join(await tmp(t), "outside.txt");
  await writeFile(outside, "host secret");
  const ws = new Workspace(root, ["input.txt"]);
  await ws.place("input.txt", "1\n2\n3\n");
  await ws.write("src/main.go", "package main\n");
  assert.equal((await ws.read("src/main.go")).text, "package main\n");
  assert.deepEqual((await ws.read("input.txt", 1, 1)).text, "2");
  for (const bad of ["/etc/passwd", "../x", "a/../b", "a//b", ".hidden", "a b", "a/b/c/d/e", ""]) {
    await assert.rejects(ws.write(bad, "x"), /Invalid path|Paths must be/, bad);
  }
  await assert.rejects(ws.write("input.txt", "tampered"), /read-only/);
  await assert.rejects(ws.write("big.txt", "x".repeat(MAX_FILE_BYTES + 1)), /too large/);
  await symlink(outside, join(root, "link.txt"));
  await assert.rejects(ws.read("link.txt"), /No such file/);
  await assert.rejects(ws.write("link.txt", "overwrite"), /Cannot write/);
  assert.equal(await readFile(outside, "utf8"), "host secret");
  await mkdir(join(root, "real"));
  await symlink(join(outside, ".."), join(root, "dirlink"));
  await assert.rejects(ws.write("dirlink/x.txt", "x"), /not a directory/);
  assert.deepEqual(
    (await ws.list()).map((e) => e.path),
    ["input.txt", "src/main.go"],
  );
});

test("program output is stripped of terminal control sequences", () => {
  assert.equal(sanitize("ok\x1b[31mred\x1b[0m\r\n\tx\x07\u009b"), "okred\n\tx\uFFFD\uFFFD");
  assert.equal(sanitize("a\x1b]0;title\x07b\x1b]2;t\x1b\\c"), "abc");
});

test("docker arguments enforce isolation and accept only digest-pinned images", () => {
  const request: RunRequest = {
    workspace: "/private/ws",
    argv: ["python3", "solve.py"],
    timeoutMs: 5_000,
  };
  const image = `sha256:${"a".repeat(64)}`;
  const args = dockerArgs({ image }, request, "boc-test");
  for (const flag of [
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--pull=never",
    "--mount=type=bind,source=/private/ws,target=/work,readonly",
  ]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.deepEqual(args.slice(-3), [image, "python3", "solve.py"]);
  const envs = args.filter((_, i) => args[i - 1] === "--env");
  assert.ok(envs.every((e) => !/TOKEN|KEY|SECRET|COOKIE/i.test(e)));
  assert.ok(!args.some((a) => a.includes("docker.sock")));
  assert.throws(() => dockerArgs({ image: "python:3" }, request, "n"), /pinned/);
  assert.throws(() => dockerArgs({ image }, { ...request, argv: [] }, "n"));
  assert.throws(() => dockerArgs({ image }, { ...request, argv: ["a\nb"] }, "n"));
  assert.throws(() => dockerArgs({ image }, { ...request, workspace: "/a,b" }, "n"));
});

const config = parseConfig({
  version: 1,
  event: { year: 2025 },
  storageDir: "/synthetic/var",
  aoc: { sessionCookieFile: "/synthetic/cookie" },
  creditPools: [
    {
      id: "pool",
      provider: "github-copilot",
      unit: "synthetic-credit",
      limits: { event: "100", perPuzzle: "4" },
    },
  ],
  subscriptions: [
    {
      id: "sub",
      provider: "github-copilot",
      credentialFile: "/synthetic/cred",
      model: FAKE_MODEL.id,
      creditPool: "pool",
      limits: { event: "100", perPuzzle: "100" },
    },
  ],
});

async function solverFixture(
  t: test.TestContext,
  script: ((c: TranscriptContext) => ReturnType<typeof message>)[],
) {
  const root = await tmp(t);
  const ledger = await CreditLedger.open({ directory: join(root, "ledger"), config });
  t.after(() => ledger.close().catch(() => {}));
  const admission = createLedgerAdmission({
    ledger,
    subscription: "sub",
    model: FAKE_MODEL.id,
    puzzle: puzzleId(1),
    meter: {
      maxCharge: () => parseCredits("1"),
      actualCharge: async () => ({ credits: parseCredits("1"), receipt: "receipt:fake" }),
    },
  });
  const contexts: TranscriptContext[] = [];
  const invoke = (_m: unknown, context: TranscriptContext) => {
    contexts.push(context);
    const step = script[contexts.length - 1];
    if (!step) throw new Error("script exhausted");
    return responseStream(step(context));
  };
  const streams = createGuardedStreams({
    model: FAKE_MODEL,
    admission,
    transport: { stream: invoke, streamSimple: invoke },
  });
  const workspace = await Workspace.create(join(root, "ws"), ["input.txt"]);
  await workspace.place("input.txt", "3\n4\n");
  const runs: RunRequest[] = [];
  const executor: Executor = {
    run: async (request) => {
      runs.push(request);
      return {
        exitCode: 0,
        timedOut: false,
        stdout: "7\n",
        stderr: "",
        truncated: false,
        durationMs: 1,
      };
    },
  };
  const proposals: string[] = [];
  const solverTools = createSolverTools({
    workspace,
    executor,
    onProposal: (a) => proposals.push(a),
  });
  return {
    ledger,
    streams,
    workspace,
    runs,
    proposals,
    tools: solverTools.tools,
    stop: () => solverTools.proposed() !== undefined,
    contexts,
  };
}

const call = (name: string, args: Record<string, string | number | string[]>) =>
  message({
    content: [{ type: "toolCall", id: `c-${name}`, name, arguments: args }],
    stopReason: "toolUse",
  });

test("the solver loop writes, runs, proposes, and stops; every turn is admitted", async (t) => {
  const f = await solverFixture(t, [
    () => call("write_file", { path: "solve.py", content: "print(7)\n" }),
    () => call("run", { argv: ["python3", "solve.py"] }),
    () => call("propose_answer", { answer: " 7 " }),
  ]);
  const agent = createSolverAgent({
    model: FAKE_MODEL,
    streams: f.streams,
    systemPrompt: "Synthetic solver prompt.",
    tools: f.tools,
    maxTurns: 10,
  });
  await agent.prompt("Solve the synthetic puzzle.");
  assert.deepEqual(f.proposals, ["7"]);
  assert.equal(f.contexts.length, 3, "propose_answer terminates without another model call");
  assert.equal(await readFile(join(f.workspace.root, "solve.py"), "utf8"), "print(7)\n");
  assert.deepEqual(
    f.runs.map((r) => r.argv),
    [["python3", "solve.py"]],
  );
  assert.equal(f.runs[0]?.workspace, f.workspace.root);
  const pool = f.ledger.status().counters.find((c) => c.scope === "pool" && c.period === "day-01");
  assert.equal(pool?.spent, parseCredits("3"));
  // The model never sees tool definitions beyond the constrained set.
  const names = JSON.stringify(f.contexts[0]);
  for (const tool of ["write_file", "read_file", "list_files", "run", "propose_answer"]) {
    assert.match(names, new RegExp(tool));
  }
  assert.doesNotMatch(names, /"bash"|"edit"|web_fetch/);
});

test("credit exhaustion and the turn cap both stop a looping solver", async (t) => {
  const loop = () => call("list_files", {});
  const f = await solverFixture(
    t,
    Array.from({ length: 10 }, () => loop),
  );
  const agent = createSolverAgent({
    model: FAKE_MODEL,
    streams: f.streams,
    systemPrompt: "Synthetic.",
    tools: f.tools,
    maxTurns: 10,
  });
  await agent.prompt("loop");
  assert.equal(f.contexts.length, 4, "per-puzzle pool limit of 4 credits");

  const g = await solverFixture(
    t,
    Array.from({ length: 10 }, () => loop),
  );
  const capped = createSolverAgent({
    model: FAKE_MODEL,
    streams: g.streams,
    systemPrompt: "Synthetic.",
    tools: g.tools,
    maxTurns: 2,
  });
  await capped.prompt("loop");
  assert.equal(g.contexts.length, 2);
  assert.throws(() =>
    createSolverAgent({
      model: FAKE_MODEL,
      streams: g.streams,
      systemPrompt: "",
      tools: [],
      maxTurns: 0,
    }),
  );
});

test("invalid proposals are rejected back to the model, not recorded", async (t) => {
  const f = await solverFixture(t, [
    () => call("propose_answer", { answer: "two words" }),
    () => call("read_file", { path: "../../etc/passwd" }),
    () => message(),
  ]);
  const agent = createSolverAgent({
    model: FAKE_MODEL,
    streams: f.streams,
    systemPrompt: "Synthetic.",
    tools: f.tools,
    maxTurns: 10,
  });
  await agent.prompt("go");
  assert.deepEqual(f.proposals, []);
  const results = JSON.stringify(f.contexts[2]);
  assert.match(results, /without whitespace/);
  assert.match(results, /Invalid path|Paths must be/);
});

test("a proposal made alongside other tool calls still ends the run; only one is accepted", async (t) => {
  const both = () =>
    message({
      content: [
        { type: "toolCall", id: "c1", name: "propose_answer", arguments: { answer: "5" } },
        { type: "toolCall", id: "c2", name: "list_files", arguments: {} },
        { type: "toolCall", id: "c3", name: "propose_answer", arguments: { answer: "6" } },
      ],
      stopReason: "toolUse",
    });
  const f = await solverFixture(t, [both, () => message()]);
  const agent = createSolverAgent({
    model: FAKE_MODEL,
    streams: f.streams,
    systemPrompt: "Synthetic.",
    tools: f.tools,
    maxTurns: 10,
    shouldStop: f.stop,
  });
  await agent.prompt("go");
  assert.equal(f.contexts.length, 1, "no model call after the proposal turn");
  assert.deepEqual(f.proposals, ["5"]);
});

test("workspace modes let the container read files even under a strict umask", async (t) => {
  const { mkdtemp, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "boc-umask-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.umask(0o077);
  try {
    const ws = await Workspace.create(join(root, "store", "ws"));
    await ws.place("input.txt", "synthetic\n");
    await ws.write("src/solve.py", "print(1)\n");
    const mode = async (path: string) => (await stat(join(ws.root, path))).mode & 0o777;
    assert.equal(await mode("."), 0o755);
    assert.equal(await mode("input.txt"), 0o644);
    assert.equal(await mode("src"), 0o755);
    assert.equal(await mode("src/solve.py"), 0o644);
    assert.equal((await stat(join(root, "store"))).mode & 0o777, 0o700, "parents stay private");
  } finally {
    process.umask(previous);
  }
});

test("the run tool's timeout cap is configurable and defaults to 60 s", async (t) => {
  const workspace = await Workspace.create(join(await tmp(t), "work"), []);
  const seen: number[] = [];
  const executor: Executor = {
    run: async (request: RunRequest) => {
      seen.push(request.timeoutMs);
      return {
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        truncated: false,
        durationMs: 1,
      };
    },
  };
  const runTool = (seconds?: number) =>
    createSolverTools({
      workspace,
      executor,
      onProposal: () => {},
      ...(seconds ? { maxRunTimeoutSeconds: seconds } : {}),
    }).tools.find((tool) => tool.name === "run");
  const byDefault = runTool();
  const raised = runTool(240);
  assert.match(byDefault?.description ?? "", /Timeout up to 60s/);
  assert.match(raised?.description ?? "", /Timeout up to 240s/);
  await byDefault?.execute("a", { argv: ["true"] });
  await raised?.execute("b", { argv: ["true"] });
  await raised?.execute("c", { argv: ["true"], timeoutSeconds: 200 });
  assert.deepEqual(seen, [60_000, 240_000, 200_000]);
  const example = JSON.parse(await readFile("examples/boc.config.json", "utf8"));
  const withCap = (maxRunSeconds: number) =>
    parseConfig({ ...example, sandbox: { image: `sha256:${"a".repeat(64)}`, maxRunSeconds } });
  assert.equal(withCap(240).sandbox?.maxRunSeconds, 240);
  assert.throws(() => withCap(541), "beyond the attempt deadline");
  assert.throws(() => withCap(0));
});

test("a run can propose its single ANSWER line when it exits cleanly (D030)", async (t) => {
  const workspace = await Workspace.create(join(await tmp(t), "work"), []);
  const reply = { exitCode: 0 as number | null, stdout: "" };
  const executor: Executor = {
    run: async () => ({
      exitCode: reply.exitCode,
      timedOut: false,
      stdout: reply.stdout,
      stderr: "",
      truncated: false,
      durationMs: 1,
    }),
  };
  const make = () => {
    const proposals: string[] = [];
    const tools = createSolverTools({
      workspace,
      executor,
      onProposal: (a) => proposals.push(a),
      refuse: (a) => (a === "13" ? "This answer was already judged wrong." : undefined),
    });
    const run = tools.tools.find((tool) => tool.name === "run");
    const call = async (propose?: boolean) => {
      const result = await run?.execute("x", {
        argv: ["python3", "solve.py"],
        ...(propose !== undefined ? { proposeOnSuccess: propose } : {}),
      });
      return {
        text: result?.content.map((c) => ("text" in c ? c.text : "")).join("") ?? "",
        terminate: result?.terminate === true,
      };
    };
    return { tools, proposals, call };
  };
  const text = (value: { text: string }) => value.text;

  reply.stdout = "example ok\nANSWER: 42\n";
  let f = make();
  assert.equal((await f.call()).terminate, false, "never without the flag");
  assert.deepEqual(f.proposals, []);
  const proposed = await f.call(true);
  assert.equal(proposed.terminate, true);
  assert.match(text(proposed), /\[proposed 42\]/);
  assert.deepEqual(f.proposals, ["42"]);
  assert.equal(f.tools.proposed(), "42");
  assert.match(text(await f.call(true)), /not proposed: an answer was already proposed/);

  for (const [exitCode, stdout, why] of [
    [1, "ANSWER: 42\n", /did not exit with code 0/],
    [0, "ANSWER: 1\nANSWER: 2\n", /printed 2 ANSWER lines/],
    [0, "no answer here\n", /printed 0 ANSWER lines/],
    [0, "ANSWER: 4 2\n", /printable characters without whitespace/],
    [0, "ANSWER: 13\n", /already judged wrong/],
  ] as const) {
    reply.exitCode = exitCode;
    reply.stdout = stdout;
    f = make();
    const result = await f.call(true);
    assert.equal(result.terminate, false, stdout);
    assert.match(text(result), why);
    assert.deepEqual(f.proposals, []);
  }
});

test("the dockerized session keeps the executor's restrictions (D030)", () => {
  const options = { image: `sha256:${"a".repeat(64)}` };
  const single = dockerArgs(options, { workspace: "/w", argv: ["true"], timeoutMs: 1 }, "n");
  const session = dockerSessionArgs(options, "/w", "n");
  assert.deepEqual(session.slice(0, 3), ["run", "--detach", "--init"]);
  assert.deepEqual(session.slice(-2), ["sleep", "infinity"]);
  for (const flag of single.slice(1, -2)) assert.ok(session.includes(flag), flag);
  assert.ok(session.includes("--label=boc.solver=1"));
  assert.deepEqual(dockerExecArgs("n", ["python3", "s.py"]), [
    "exec",
    "--user=65534:65534",
    "--workdir=/work",
    "n",
    "python3",
    "s.py",
  ]);
  assert.throws(() => dockerExecArgs("n", []));
  assert.throws(() => dockerExecArgs("n", ["bad\nline"]));
});
