import { randomUUID } from "node:crypto";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export interface AdmissionRequest {
  /** Unique per dispatch attempt, not per outer prompt or retry group. */
  readonly id: string;
  readonly model: Model<Api>;
  readonly context: TranscriptContext;
  /** Trusted request settings; never persist this object (it can contain auth). */
  readonly options: Readonly<SimpleStreamOptions>;
  readonly signal: AbortSignal | undefined;
}

export interface Reservation {
  /**
   * Reconcile an authoritative native-credit receipt before publishing completion.
   * Missing/invalid receipts must throw WITHOUT releasing the reservation.
   * Pi's token counts and usage.cost are not authoritative subscription credits.
   */
  settle(message: AssistantMessage): Promise<void>;
  /**
   * Optional annotation when the guard gives up without settling. It MUST NOT
   * release the reservation: "not-dispatched" is advisory for later reconciliation.
   */
  abandon?(reason: "not-dispatched" | "outcome-uncertain"): Promise<void>;
}

export interface Admission {
  /**
   * Resolve only after reserving a certified maximum debit against every limit.
   * Production implementations must persist the reservation atomically. A rejected
   * or cancelled operation must not imply that a prior reservation was released.
   */
  reserve(request: AdmissionRequest): Promise<Reservation>;
}

interface GuardedStreamsOptions {
  model: Model<Api>;
  admission: Admission;
  /** Trusted adapter, not a model-supplied tool or arbitrary provider selection. */
  transport: ProviderStreams;
}

/**
 * One shared admission path for native and simple Pi streams. No implicit retries.
 * This is a dispatch boundary, not a ledger, pricing oracle, or credential sandbox.
 * An adapter with internal unbounded retries/charges is NOT eligible to use it live.
 */
type RequestOptions = SimpleStreamOptions;

/**
 * Explicit option allowlist. Everything else is dropped, including callbacks and
 * transports that can rewrite the approved request after admission (`onPayload`,
 * `fetch`, `env`, `transformHeaders`, `samplingParams`, `metadata`, telemetry).
 * `apiKey` and `headers` come from Pi's trusted auth resolution; a live adapter must
 * additionally pin its exact header set. Data fields are deep-cloned.
 */
function sanitizeOptions(input: RequestOptions | undefined): RequestOptions {
  const options = input ?? {};
  if ((options.maxRetries ?? 0) !== 0 || (options.transport ?? "sse") !== "sse") {
    throw new Error("Retries and alternate transports are disabled.");
  }
  if (options.deferred) throw new Error("Deferred requests are disabled.");
  const result: RequestOptions = { transport: "sse", maxRetries: 0 };
  for (const key of [
    "apiKey",
    "timeoutMs",
    "maxRetryDelayMs",
    "temperature",
    "maxTokens",
    "sessionId",
    "cacheRetention",
    "reasoning",
  ] as const) {
    if (options[key] !== undefined) Object.assign(result, { [key]: options[key] });
  }
  for (const key of ["headers", "toolChoice", "thinkingBudgets"] as const) {
    if (options[key] !== undefined) Object.assign(result, { [key]: structuredClone(options[key]) });
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createGuardedStreams(config: GuardedStreamsOptions): ProviderStreams {
  const canonical = structuredClone(config.model);
  let faulted = false;

  const dispatch = (
    mode: "stream" | "streamSimple",
    requestedModel: Model<Api>,
    context: TranscriptContext,
    incomingOptions?: RequestOptions,
  ): AssistantMessageEventStream => {
    const signal = incomingOptions?.signal;
    const output = createAssistantMessageEventStream();
    const failure = (aborted: boolean): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: canonical.api,
      provider: canonical.provider,
      model: canonical.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: aborted ? "aborted" : "error",
      errorMessage: aborted
        ? "Request aborted; any unresolved reservation remains held."
        : "Request blocked or failed; any unresolved reservation remains held.",
      timestamp: Date.now(),
    });

    // Snapshot synchronously, before any await, so later caller mutation is irrelevant.
    let snapshot: { model: Model<Api>; context: TranscriptContext; options: RequestOptions };
    let setupError = false;
    try {
      snapshot = deepFreeze({
        model: structuredClone(canonical),
        context: structuredClone(context),
        options: sanitizeOptions(incomingOptions),
      });
    } catch {
      setupError = true;
      snapshot = undefined as never;
    }

    // The stream API must return immediately; asynchronous admission happens before
    // invoking the adapter, and every path still resolves the terminal stream result.
    void (async () => {
      // Once true, any failure is an uncertain charge: keep it held and fault.
      let reservation: Reservation | undefined;
      let dispatched = false;
      let settling = false;
      try {
        if (faulted) throw new Error("Dispatch boundary is faulted.");
        if (setupError) throw new Error("Request options are not allowed.");
        if (
          requestedModel.provider !== canonical.provider ||
          requestedModel.id !== canonical.id ||
          requestedModel.api !== canonical.api ||
          requestedModel.baseUrl !== canonical.baseUrl
        ) {
          throw new Error("Model is not allowlisted.");
        }
        signal?.throwIfAborted();
        // Admission sees exactly the frozen snapshot the transport will receive.
        const admitted = await config.admission.reserve({
          id: randomUUID(),
          model: snapshot.model,
          context: snapshot.context,
          options: snapshot.options,
          signal,
        });
        if (!admitted || typeof admitted.settle !== "function") {
          throw new Error("No reservation returned.");
        }
        reservation = admitted;
        signal?.throwIfAborted();
        if (faulted) throw new Error("Another request faulted while admission was pending.");
        dispatched = true;
        const upstream = config.transport[mode](
          structuredClone(snapshot.model),
          structuredClone(snapshot.context),
          { ...structuredClone(snapshot.options), ...(signal ? { signal } : {}) },
        );
        let started = false;
        for await (const event of upstream) {
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            if (event.type === "done" && !started) throw new Error("Invalid stream protocol.");
            // Aborted, deferred, or pending outcomes have unknown charge: never settle.
            if (
              message.stopReason === "aborted" ||
              message.stopReason === "deferred" ||
              message.stopReason === "pending" ||
              signal?.aborted
            ) {
              throw new Error("Outcome is uncertain.");
            }
            // Do not expose terminal success (which enables tool execution) until
            // settlement succeeds. Settlement failure keeps the reservation held.
            settling = true;
            await reservation.settle(structuredClone(message));
            if (event.type === "error") {
              output.push({ type: "error", reason: "error", error: failure(false) });
            } else {
              output.push(event);
            }
            output.end();
            return;
          }
          if (event.type === "start") started = true;
          else if (!started) throw new Error("Invalid stream protocol.");
          output.push(event);
        }
        throw new Error("Transport ended without a terminal receipt.");
      } catch {
        // Pre-admission denials hold nothing and leave the boundary usable.
        if (reservation) {
          faulted = true;
          // Settlement owns its own failure annotation; otherwise annotate here.
          if (!settling && typeof reservation.abandon === "function") {
            await reservation
              .abandon(dispatched ? "outcome-uncertain" : "not-dispatched")
              .catch(() => {});
          }
        }
        const error = failure(signal?.aborted === true);
        output.push({ type: "error", reason: error.stopReason as "error" | "aborted", error });
        output.end();
      }
    })();
    return output;
  };

  return Object.freeze({
    stream: (model, context, options) => dispatch("stream", model, context, options),
    streamSimple: (model, context, options) => dispatch("streamSimple", model, context, options),
  } satisfies ProviderStreams);
}
