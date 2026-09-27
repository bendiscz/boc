import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";

/**
 * BoC-owned agent loop (D015): pi-agent-core's `Agent` with exactly one model
 * dispatch path, the guarded provider stream. No ModelRuntime, provider catalog,
 * ambient credential discovery, compaction, summaries, cache warming, or retries
 * exist in this loop. Credit admission happens inside `streams` on every turn.
 */

export interface SolverAgentOptions {
  readonly model: Model<Api>;
  /** Must be the guarded streams (`createGuardedStreams`), never a raw provider. */
  readonly streams: ProviderStreams;
  readonly systemPrompt: string;
  readonly tools: AgentTool[];
  /** Hard cap on provider turns per run, independent of credits. */
  readonly maxTurns: number;
  /**
   * Checked after every turn; true ends the run. pi-agent-core only terminates a
   * tool batch when every result asks for it, so a proposal made alongside other
   * tool calls must be enforced here.
   */
  readonly shouldStop?: () => boolean;
}

export function createSolverAgent(options: SolverAgentOptions): Agent {
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
    throw new Error("maxTurns must be a positive integer.");
  }
  let turns = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: structuredClone(options.model),
      thinkingLevel: "off",
      tools: options.tools,
      messages: [],
    },
    // The only dispatch path. Pi's transport/retry options are rejected by the guard.
    streamFn: (model, context, streamOptions) =>
      options.streams.streamSimple(model, context, streamOptions),
    transport: "sse",
    toolExecution: "sequential",
    finishTurn: () => {
      turns++;
      if (options.shouldStop?.() || turns >= options.maxTurns) return { action: "end" };
      return undefined;
    },
  });
  return agent;
}
