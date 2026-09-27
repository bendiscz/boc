import { open } from "node:fs/promises";

/**
 * Trusted AoC HTTP client. Only the orchestrator may construct it; solver code
 * never receives the cookie, this object, or network access.
 *
 * - Host pinned to https://adventofcode.com; paths built from validated integers.
 * - Session cookie read from a private file (owner-only permissions required),
 *   kept in a closure, and never included in errors, logs, or return values.
 * - Identifiable User-Agent with operator contact (AoC automation guidance).
 * - Requests are serialized with a minimum spacing, time out, never follow
 *   redirects, and have bounded response sizes. No automatic retries.
 * - Errors carry fixed messages and codes only (no URLs, bodies, or cookie).
 */

export const AOC_ORIGIN = "https://adventofcode.com";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const COOKIE_PATTERN = /^[A-Za-z0-9]{16,512}(?![\s\S])/;

export type AocErrorCode =
  | "config"
  | "auth"
  | "not-available"
  | "http"
  | "network"
  | "timeout"
  | "too-large";

export class AocError extends Error {
  readonly code: AocErrorCode;
  readonly status: number | undefined;
  /**
   * True once a request was dispatched (every HTTP-level failure). For submissions
   * the outcome is then unknown: record it as uncertain and reconcile from the
   * puzzle page; never retry automatically.
   */
  readonly mayHaveReachedServer: boolean;
  constructor(code: AocErrorCode, message: string, status?: number, mayHaveReached = false) {
    super(message);
    this.name = "AocError";
    this.code = code;
    this.status = status;
    this.mayHaveReachedServer = mayHaveReached;
  }
}

export interface AocClientOptions {
  readonly cookieFile: string;
  readonly contact: string | undefined;
  readonly version: string;
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Minimum spacing between request starts. */
  readonly minIntervalMs?: number;
  readonly timeoutMs?: number;
}

export type AocRequest =
  | { readonly kind: "puzzle"; readonly year: number; readonly day: number }
  | { readonly kind: "input"; readonly year: number; readonly day: number }
  | {
      readonly kind: "answer";
      readonly year: number;
      readonly day: number;
      readonly part: 1 | 2;
      readonly answer: string;
    };

export interface AocClient {
  /** Load and validate the session cookie now, so later failures imply dispatch. */
  prepare(): Promise<void>;
  fetchPuzzle(year: number, day: number): Promise<string>;
  fetchInput(year: number, day: number): Promise<string>;
  submitAnswer(year: number, day: number, part: 1 | 2, answer: string): Promise<string>;
}

async function readCookie(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    const owner = process.getuid?.();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (owner !== undefined && info.uid !== owner)
    ) {
      throw new AocError("config", "Session cookie file must be a regular owner-only file.");
    }
    if (info.size > 4096) throw new AocError("config", "Session cookie file is malformed.");
    const value = (await handle.readFile("utf8")).trim().replace(/^session=/, "");
    if (!COOKIE_PATTERN.test(value)) {
      throw new AocError("config", "Session cookie file is malformed.");
    }
    return value;
  } catch (error) {
    if (error instanceof AocError) throw error;
    throw new AocError("config", "Cannot read the session cookie file.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateContact(contact: string | undefined): string {
  if (!contact || !/^[\x21-\x7e][\x20-\x7e]{0,199}$/.test(contact) || /[;()]/.test(contact)) {
    throw new AocError("config", "An operator contact is required for the AoC User-Agent.");
  }
  return contact;
}

function validateTarget(year: number, day: number): void {
  if (!Number.isInteger(year) || year < 2015 || year > 9999) {
    throw new AocError("config", "Invalid event year.");
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new AocError("config", "Invalid day.");
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new AocError("too-large", "AoC response too large.");
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new AocError("too-large", "AoC response too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createAocClient(options: AocClientOptions): AocClient {
  const contact = validateContact(options.contact);
  const userAgent = `BotOfCode/${options.version} (+https://github.com/bendiscz/boc; contact: ${contact})`;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const minIntervalMs = options.minIntervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let cookie: Promise<string> | undefined;
  let lastStart = Number.NEGATIVE_INFINITY;
  let tail: Promise<unknown> = Promise.resolve();

  const loadCookie = () => {
    cookie ??= readCookie(options.cookieFile);
    return cookie.catch((error: unknown) => {
      cookie = undefined;
      throw error;
    });
  };

  const request = (target: AocRequest): Promise<string> => {
    const run = async () => {
      validateTarget(target.year, target.day);
      const base = `${AOC_ORIGIN}/${target.year}/day/${target.day}`;
      const url = target.kind === "puzzle" ? base : `${base}/${target.kind}`;
      const isAnswer = target.kind === "answer";
      let body: string | undefined;
      if (isAnswer) {
        if (
          !/^[\x21-\x7e]{1,200}$/.test(target.answer) ||
          (target.part !== 1 && target.part !== 2)
        ) {
          throw new AocError("config", "Invalid answer submission.");
        }
        body = new URLSearchParams({
          level: String(target.part),
          answer: target.answer,
        }).toString();
      }
      const session = await loadCookie();
      const wait = lastStart + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      let response: Response;
      try {
        response = await doFetch(url, {
          method: isAnswer ? "POST" : "GET",
          headers: {
            "User-Agent": userAgent,
            Cookie: `session=${session}`,
            ...(isAnswer ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          },
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = (error as Error | undefined)?.name === "TimeoutError";
        // Any failure after dispatch may have reached the server.
        throw new AocError(
          timedOut ? "timeout" : "network",
          timedOut ? "AoC request timed out." : "AoC request failed.",
          undefined,
          true,
        );
      }
      const status = response.status;
      try {
        if (status === 200) return await readBounded(response);
      } catch (error) {
        if (error instanceof AocError) throw new AocError(error.code, error.message, status, true);
        throw new AocError("network", "AoC response could not be read.", status, true);
      }
      await response.body?.cancel().catch(() => {});
      if (status === 404) {
        throw new AocError("not-available", "Puzzle not available yet.", status, true);
      }
      if (status >= 300 && status < 400) {
        // AoC does not redirect authenticated requests we make; treat as auth trouble.
        throw new AocError("auth", "AoC redirected the request; check the session.", status, true);
      }
      if (status === 400 || status === 401 || status === 403) {
        throw new AocError("auth", "AoC rejected the session.", status, true);
      }
      throw new AocError("http", "Unexpected AoC HTTP status.", status, true);
    };
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    return result;
  };

  return Object.freeze({
    prepare: async () => {
      await loadCookie();
    },
    fetchPuzzle: (year: number, day: number) => request({ kind: "puzzle", year, day }),
    fetchInput: (year: number, day: number) => request({ kind: "input", year, day }),
    submitAnswer: (year: number, day: number, part: 1 | 2, answer: string) =>
      request({ kind: "answer", year, day, part, answer }),
  });
}
