import type { BocConfig } from "../config.ts";
import { readPrivateFile } from "../util/private-file.ts";

/**
 * Operator alerts (D023): ntfy push notifications and a healthchecks.io
 * dead-man's switch. Only the trusted orchestrator sends them. Destinations come
 * from private files and never appear in logs or errors. Alerts carry no puzzle
 * text, inputs, or answers. Delivery is best effort: it never throws into a run,
 * is bounded by timeouts, deduplicated, and rate limited.
 */

export type AlertPriority = "urgent" | "high" | "default" | "low";

export interface Alert {
  readonly priority: AlertPriority;
  readonly title: string;
  readonly message: string;
}

export interface Notifier {
  /** Push an alert (best effort; never throws). */
  notify(alert: Alert): void;
  /** Dead-man's switch: `true` pings success, `false` signals a failure. */
  heartbeat(ok: boolean): void;
  /** Wait (bounded) for pending deliveries, e.g. before exit. */
  flush(timeoutMs?: number): Promise<void>;
}

export const SILENT_NOTIFIER: Notifier = Object.freeze({
  notify: () => {},
  heartbeat: () => {},
  flush: async () => {},
});

export class AlertConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertConfigError";
  }
}

const NTFY_PRIORITY: Record<AlertPriority, string> = {
  urgent: "5",
  high: "4",
  default: "3",
  low: "2",
};
const DEDUPE_MS = 10 * 60_000;
const RATE_WINDOW_MS = 60 * 60_000;
const RATE_MAX = 30;
const TIMEOUT_MS = 10_000;

function secretUrl(text: string, label: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new AlertConfigError(`The ${label} file does not contain a valid URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new AlertConfigError(`The ${label} URL must be a plain https:// URL.`);
  }
  return url.toString();
}

/** Printable ASCII for HTTP header values (titles); bounded plain text for bodies. */
function headerText(value: string, max: number): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}
function bodyText(value: string, max: number): string {
  return value.replace(/[\p{Cc}&&[^\n]]/gv, "").slice(0, max);
}

export interface NotifierOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Local log for delivery problems (never contains the destination). */
  readonly log?: (message: string) => void;
}

export async function createNotifier(
  alerts: BocConfig["alerts"],
  options: NotifierOptions = {},
): Promise<Notifier> {
  if (!alerts?.ntfy && !alerts?.healthchecks) return SILENT_NOTIFIER;
  const read = async (path: string, label: string) => {
    try {
      return await readPrivateFile(path, 4096);
    } catch {
      throw new AlertConfigError(`Cannot read the ${label} file (it must be owner-only, 0600).`);
    }
  };
  const topic = alerts.ntfy
    ? secretUrl(await read(alerts.ntfy.topicUrlFile, "ntfy topic"), "ntfy topic")
    : undefined;
  const token = alerts.ntfy?.tokenFile
    ? (await read(alerts.ntfy.tokenFile, "ntfy token")).trim()
    : undefined;
  if (token !== undefined && !/^[\x21-\x7e]{1,512}$/.test(token)) {
    throw new AlertConfigError("The ntfy token file is malformed.");
  }
  const ping = alerts.healthchecks
    ? secretUrl(
        await read(alerts.healthchecks.pingUrlFile, "healthchecks ping"),
        "healthchecks ping",
      ).replace(/\/+$/, "")
    : undefined;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const pending = new Set<Promise<void>>();
  const recent = new Map<string, number>();
  const sent: number[] = [];
  let suppressed = 0;

  const deliver = (what: string, url: string, init: RequestInit) => {
    const task = (async () => {
      try {
        const response = await doFetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await response.body?.cancel().catch(() => {});
        if (!response.ok) log(`${what} delivery failed (HTTP ${response.status})`);
      } catch {
        log(`${what} delivery failed`);
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const push = (alert: Alert) => {
    if (!topic) return;
    const title = headerText(alert.title, 200);
    const message = bodyText(alert.message, 2000);
    deliver("alert", topic, {
      method: "POST",
      body: message,
      headers: {
        Title: title,
        Priority: NTFY_PRIORITY[alert.priority],
        Tags: alert.priority === "urgent" ? "rotating_light" : "robot",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  };

  return {
    notify(alert) {
      if (!topic) return;
      const at = now();
      const key = `${alert.priority}\n${alert.title}\n${alert.message}`;
      for (const [k, t] of recent) if (at - t >= DEDUPE_MS) recent.delete(k);
      if (recent.has(key)) return;
      recent.set(key, at);
      while (sent.length > 0 && at - (sent[0] ?? 0) >= RATE_WINDOW_MS) sent.shift();
      if (sent.length >= RATE_MAX) {
        suppressed++;
        return;
      }
      if (suppressed > 0) {
        const note = suppressed;
        suppressed = 0;
        sent.push(at);
        push({
          priority: "high",
          title: "BoC: alerts suppressed",
          message: `${note} alert(s) were suppressed by the rate limit; check the run log.`,
        });
        if (sent.length >= RATE_MAX) return;
      }
      sent.push(at);
      push(alert);
    },
    heartbeat(ok) {
      if (!ping) return;
      deliver("heartbeat", ok ? ping : `${ping}/fail`, { method: "POST", body: "" });
    },
    async flush(timeoutMs = TIMEOUT_MS) {
      if (pending.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
