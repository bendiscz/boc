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
  /**
   * Best-effort streaming cutoff (D016): true when the partial response's running
   * cost estimate exceeds the reservation. The guard then aborts the request and
   * calls `settleCutoff`; without it, the outcome is uncertain and stays held.
   */
  exceeds?(partial: AssistantMessage): boolean;
  settleCutoff?(partial: AssistantMessage): Promise<void>;
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
  /**
   * Raw text of a provider's terminal error, for private diagnostics only (the
   * trusted orchestrator stores it beside the transcript; never the model or logs).
   */
  onProviderError?: (raw: string) => void;
  /** Wall-clock limit per response; a stopped response settles like the credit cutoff. */
  maxResponseMs?: number;
  /** Longest gap between stream events before the response counts as stalled. */
  stallMs?: number;
  /** Partial output of a response the guard stopped, for private diagnostics only. */
  onCutoff?: (partial: AssistantMessage, reason: string) => void;
  /** Notified once when an uncertain outcome permanently faults this guard. */
  onFault?: () => void;
  /**
   * Output-token cap applied to every request (min of any requested value and this),
   * so admission estimates and the provider see the same enforced limit.
   */
  outputCap?: number;
}

/**
 * One shared admission path for native and simple Pi streams. No implicit retries.
 * This is a dispatch boundary, not a ledger, pricing oracle, or credential sandbox.
 * An adapter with internal unbounded retries/charges is NOT eligible to use it live.
 */
type RequestOptions = SimpleStreamOptions;

/** Error text of a response the guard stopped at its credit estimate. */
export const CUTOFF_MESSAGE = "Response stopped: it exceeded its credit estimate.";

/** Error text of a response the guard stopped at its time limit. */
export const RESPONSE_TIME_MESSAGE = "Response stopped: it exceeded its time limit.";
/** Error text of a response the guard stopped because the stream stalled. */
export const STALL_MESSAGE = "Response stopped: the stream stalled.";
/** Every guard-imposed stop of a runaway response. */
export const RUNAWAY_MESSAGES = [CUTOFF_MESSAGE, RESPONSE_TIME_MESSAGE, STALL_MESSAGE] as const;

/** Prefix of a provider usage-limit refusal, as exposed to callers. */
export const USAGE_LIMIT_MESSAGE = "Provider usage limit reached.";
/** Prefix of a provider credential rejection, as exposed to callers. */
export const CREDENTIAL_MESSAGE = "Provider rejected the credential; run boc login.";
/** Refusals where retrying now only burns attempts. */
export const PROVIDER_REFUSALS = [USAGE_LIMIT_MESSAGE, CREDENTIAL_MESSAGE] as const;

/**
 * Safe description of a provider's terminal error. Raw provider text never leaves
 * the guard (it may echo request content); only a category and, for usage limits,
 * the provider's announced reset time in whole minutes.
 */
export function providerErrorMessage(raw: string | undefined): string {
  const text = raw ?? "";
  if (
    /invalidated oauth token|invalid.?(api.?key|token|credential)|token (has )?expired|unauthori[sz]ed|\b401\b|authentication (failed|required)/i.test(
      text,
    )
  ) {
    return CREDENTIAL_MESSAGE;
  }
  if (/usage.?limit|rate.?limit|quota|insufficient|\b429\b|too many requests/i.test(text)) {
    const minutes = /try again in ~?(\d{1,5}) ?min/i.exec(text)?.[1];
    return `${USAGE_LIMIT_MESSAGE}${minutes ? ` Retry in about ${Number(minutes)} min.` : ""}`;
  }
  return "Provider returned an error; any unresolved reservation remains held.";
}

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

function capOutput(options: RequestOptions, cap: number | undefined): RequestOptions {
  if (cap === undefined) return options;
  if (!Number.isInteger(cap) || cap < 1) throw new Error("Invalid output cap.");
  return { ...options, maxTokens: Math.min(options.maxTokens ?? cap, cap) };
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
    const failure = (aborted: boolean, detail?: string): AssistantMessage => ({
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
        : (detail ?? "Request blocked or failed; any unresolved reservation remains held."),
      timestamp: Date.now(),
    });

    // Snapshot synchronously, before any await, so later caller mutation is irrelevant.
    let snapshot: { model: Model<Api>; context: TranscriptContext; options: RequestOptions };
    let setupError = false;
    try {
      snapshot = deepFreeze({
        model: structuredClone(canonical),
        context: structuredClone(context),
        options: capOutput(sanitizeOptions(incomingOptions), config.outputCap),
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
        // Internal controller so the guard itself can stop a runaway response.
        const cutoff = new AbortController();
        const forward = () => cutoff.abort(signal?.reason);
        signal?.addEventListener("abort", forward, { once: true });
        const upstream = config.transport[mode](
          structuredClone(snapshot.model),
          structuredClone(snapshot.context),
          { ...structuredClone(snapshot.options), signal: cutoff.signal },
        );
        let started = false;
        let partial: AssistantMessage | undefined;
        // Time limits (D016 runaway protection): the credit cutoff alone lets a slow
        // stream run for many minutes. A limit stops the response like the cutoff.
        let stoppedFor: string | undefined;
        let wake: () => void = () => {};
        const stopped = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const stop = (why: string) => {
          if (stoppedFor) return;
          stoppedFor = why;
          cutoff.abort(new Error(why));
          wake();
        };
        const timers: ReturnType<typeof setTimeout>[] = [];
        let stall: ReturnType<typeof setTimeout> | undefined;
        const armStall = () => {
          if (!config.stallMs) return;
          if (stall) clearTimeout(stall);
          stall = setTimeout(() => stop(STALL_MESSAGE), config.stallMs);
        };
        if (config.maxResponseMs) {
          timers.push(setTimeout(() => stop(RESPONSE_TIME_MESSAGE), config.maxResponseMs));
        }
        armStall();
        const settleStopped = async (why: string) => {
          if (
            typeof reservation?.settleCutoff !== "function" ||
            typeof reservation.exceeds !== "function"
          ) {
            throw new Error("Stopped response cannot be settled.");
          }
          settling = true;
          // Billed tokens up to the stop are unknown: settled like the credit cutoff.
          await reservation.settleCutoff(structuredClone(partial ?? failure(false)));
          try {
            if (partial) config.onCutoff?.(structuredClone(partial), why);
          } catch {
            // Observers must not affect the boundary.
          }
          output.push({ type: "error", reason: "error", error: failure(false, why) });
          output.end();
        };
        const iterator = upstream[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await Promise.race([iterator.next(), stopped.then(() => undefined)]);
            if (stoppedFor && !signal?.aborted) {
              await settleStopped(stoppedFor);
              return;
            }
            if (!next || next.done) break;
            const event = next.value;
            armStall();
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
                try {
                  config.onProviderError?.(String(message.errorMessage ?? "").slice(0, 4000));
                } catch {
                  // Observers must not affect the boundary.
                }
                output.push({
                  type: "error",
                  reason: "error",
                  error: failure(false, providerErrorMessage(message.errorMessage)),
                });
              } else {
                output.push(event);
              }
              output.end();
              return;
            }
            if (event.type === "start") started = true;
            else if (!started) throw new Error("Invalid stream protocol.");
            partial = event.partial;
            if (
              typeof reservation.exceeds === "function" &&
              typeof reservation.settleCutoff === "function" &&
              reservation.exceeds(structuredClone(partial))
            ) {
              stoppedFor = CUTOFF_MESSAGE;
              cutoff.abort(new Error("Credit estimate exceeded."));
              await settleStopped(CUTOFF_MESSAGE);
              return;
            }
            output.push(event);
          }
        } finally {
          for (const timer of timers) clearTimeout(timer);
          if (stall) clearTimeout(stall);
          signal?.removeEventListener("abort", forward);
          if (stoppedFor) void iterator.return?.().catch(() => {});
        }
        throw new Error("Transport ended without a terminal receipt.");
      } catch {
        // Pre-admission denials hold nothing and leave the boundary usable.
        if (reservation) {
          if (!faulted) {
            faulted = true;
            try {
              config.onFault?.();
            } catch {
              // Observers must not affect the boundary.
            }
          }
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
