import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dockerArgs } from "../src/sandbox/executor.ts";
import { Workspace } from "../src/sandbox/workspace.ts";
import { createSolverTools } from "../src/solver/tools.ts";

/**
 * Audit that the untrusted side (model tools and generated code) has no path to
 * existing solutions: no network, no host files outside the attempt workspace,
 * no credentials, no AoC access. Complements the opt-in Docker probe, which
 * checks the same properties inside a real container.
 */

const src = fileURLToPath(new URL("../src/", import.meta.url));

async function sources(dir: string): Promise<[string, string][]> {
  const entries = await readdir(join(src, dir));
  return Promise.all(
    entries
      .filter((e) => e.endsWith(".ts"))
      .map(
        async (e) => [`${dir}/${e}`, await readFile(join(src, dir, e), "utf8")] as [string, string],
      ),
  );
}

test("the solver tool set is exactly the constrained five", () => {
  const tools = createSolverTools({
    workspace: new Workspace("/nonexistent"),
    executor: { run: async () => assert.fail("not called") },
    onProposal: () => {},
  }).tools;
  assert.deepEqual(
    tools.map((t) => t.name),
    ["write_file", "read_file", "list_files", "run", "propose_answer"],
  );
  for (const tool of tools) {
    const schema = JSON.stringify(tool.parameters);
    assert.doesNotMatch(schema, /url|host|http|fetch|cookie|token/i, tool.name);
  }
});

test("solver and sandbox code imports no network, AoC, provider, or credential modules", async () => {
  const forbidden = [
    /from "node:(http|https|http2|net|tls|dgram|dns)"/,
    /\bfetch\(/,
    /from "\.\.\/aoc\//,
    /from "\.\.\/providers\//,
    /from "\.\.\/config\.ts"/,
    /process\.env\b(?!\[key\])/,
  ];
  const files = [...(await sources("solver")), ...(await sources("sandbox"))];
  // run.ts is the trusted orchestrator of the solver; it may use AoC (never exposed to tools).
  for (const [name, content] of files.filter(([n]) => n !== "solver/run.ts")) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, `${name} must not match ${pattern}`);
    }
  }
  const tools = files.find(([n]) => n === "solver/tools.ts")?.[1] ?? "";
  assert.doesNotMatch(
    tools,
    /from "node:(fs|child_process)/,
    "tools act only via Workspace/Executor",
  );
});

test("generated code gets no network, host mounts, inherited environment, or socket", () => {
  process.env.BOC_AUDIT_CANARY = "synthetic-canary";
  try {
    const args = dockerArgs(
      { image: `sha256:${"b".repeat(64)}` },
      { workspace: "/private/attempt/work", argv: ["python3", "solve.py"], timeoutMs: 1_000 },
      "boc-audit",
    );
    const joined = args.join("\n");
    assert.ok(args.includes("--network=none"));
    assert.equal(
      args.filter((a) => a.startsWith("--mount=") || a === "-v" || a.startsWith("--volume")).length,
      1,
    );
    assert.match(
      joined,
      /--mount=type=bind,source=\/private\/attempt\/work,target=\/work,readonly/,
    );
    assert.doesNotMatch(
      joined,
      /synthetic-canary|docker\.sock|--privileged|--env-file|--add-host|--dns/,
    );
    assert.ok(!args.some((a) => /^--(network|net)=(host|bridge)/.test(a)));
  } finally {
    delete process.env.BOC_AUDIT_CANARY;
  }
});
