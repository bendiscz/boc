import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Executor } from "../sandbox/executor.ts";
import type { Workspace } from "../sandbox/workspace.ts";
import { isAnswer } from "../state/ids.ts";

/**
 * The complete solver tool set. None of them reach the network, the host
 * filesystem outside the attempt workspace, credentials, or AoC; `run` only
 * reaches the networkless container executor. Proposing an answer does not
 * submit it: the trusted orchestrator decides.
 */

export interface SolverToolsOptions {
  readonly workspace: Workspace;
  readonly executor: Executor;
  readonly maxRunTimeoutSeconds?: number;
  /** Called with a validated answer; the orchestrator records and may submit it. */
  readonly onProposal: (answer: string) => void;
}

const text = (value: string) => [{ type: "text" as const, text: value }];

export interface SolverTools {
  readonly tools: AgentTool[];
  /** The single accepted proposal, if any; pass `() => proposed() !== undefined` as shouldStop. */
  proposed(): string | undefined;
}

export function createSolverTools(options: SolverToolsOptions): SolverTools {
  let proposal: string | undefined;
  const maxSeconds = options.maxRunTimeoutSeconds ?? 60;
  const writeFile: AgentTool = {
    name: "write_file",
    label: "Write file",
    description:
      "Create or replace a text file in the solution workspace (relative path, e.g. solve.py).",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const { path, content } = params as { path: string; content: string };
      await options.workspace.write(path, content);
      return { content: text(`Wrote ${path} (${Buffer.byteLength(content)} bytes).`), details: {} };
    },
  };
  const readFile: AgentTool = {
    name: "read_file",
    label: "Read file",
    description:
      "Read lines from a workspace file such as input.txt. Use offset/limit for large files.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    execute: async (_id, params) => {
      const { path, offset, limit } = params as { path: string; offset?: number; limit?: number };
      const result = await options.workspace.read(path, offset ?? 0, limit ?? 200);
      return {
        content: text(`${result.text}\n[${result.totalLines} lines total]`),
        details: {},
      };
    },
  };
  const listFiles: AgentTool = {
    name: "list_files",
    label: "List files",
    description: "List files in the solution workspace.",
    parameters: Type.Object({}),
    execute: async () => {
      const entries = await options.workspace.list();
      return {
        content: text(entries.map((e) => `${e.path} (${e.size} bytes)`).join("\n") || "(empty)"),
        details: {},
      };
    },
  };
  const run: AgentTool = {
    name: "run",
    label: "Run program",
    description: `Run a command in an isolated offline container with the workspace mounted read-only at /work (the current directory). Available: python3 (uv, common libraries preinstalled), node, go, cargo/rustc. Writable scratch: /tmp (build output goes there; /work is read-only, so copy Cargo projects to /tmp before building, or use rustc -o /tmp/prog). No network: only preinstalled libraries are available. Use ["sh","-c","..."] for pipelines. Timeout up to ${maxSeconds}s. Example argv: ["python3","solve.py"].`,
    parameters: Type.Object({
      argv: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: maxSeconds })),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      const { argv, timeoutSeconds } = params as { argv: string[]; timeoutSeconds?: number };
      const result = await options.executor.run({
        workspace: options.workspace.root,
        argv,
        timeoutMs: Math.min(timeoutSeconds ?? maxSeconds, maxSeconds) * 1_000,
        ...(signal ? { signal } : {}),
      });
      const status = result.timedOut ? "timed out" : `exit code ${result.exitCode ?? "unknown"}`;
      const note = result.truncated ? "\n[output truncated]" : "";
      return {
        content: text(
          `${status} after ${result.durationMs} ms\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}${note}`,
        ),
        details: { exitCode: result.exitCode, timedOut: result.timedOut },
      };
    },
  };
  const propose: AgentTool = {
    name: "propose_answer",
    label: "Propose answer",
    description:
      "Propose the final answer for the current part once your program produced it for the real input. The orchestrator decides whether to submit it; this ends your turn.",
    parameters: Type.Object({ answer: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const answer = String((params as { answer: string }).answer).trim();
      if (proposal !== undefined) throw new Error("An answer was already proposed.");
      if (!isAnswer(answer)) {
        throw new Error("Answers must be 1-200 printable characters without whitespace.");
      }
      proposal = answer;
      options.onProposal(answer);
      return { content: text("Answer recorded."), details: {}, terminate: true };
    },
  };
  return { tools: [writeFile, readFile, listFiles, run, propose], proposed: () => proposal };
}
