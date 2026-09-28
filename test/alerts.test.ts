import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AlertConfigError, createNotifier, SILENT_NOTIFIER } from "../src/alerts/notifier.ts";

// Synthetic destinations only; nothing is contacted.
const TOPIC = "https://ntfy.example.invalid/boc-synthetic-topic-4f1c";
const PING = "https://hc.example.invalid/ping/00000000-0000-4000-8000-000000000000";

async function files(t: test.TestContext, contents: Record<string, string>, mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), "boc-alerts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(contents)) {
    const path = join(dir, name);
    await writeFile(path, content);
    await chmod(path, mode);
    paths[name] = path;
  }
  return paths;
}

function recorder(status = 200) {
  const requests: { url: string; method: string; headers: Headers; body: string }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return new Response("ok", { status });
  }) as typeof fetch;
  return { requests, impl };
}

test("no alerts configured means a silent notifier", async () => {
  assert.equal(await createNotifier(undefined), SILENT_NOTIFIER);
  assert.equal(await createNotifier({}), SILENT_NOTIFIER);
});

test("alert destinations must be private files with plain https URLs", async (t) => {
  const open = await files(t, { topic: `${TOPIC}\n` }, 0o644);
  await assert.rejects(
    createNotifier({ ntfy: { topicUrlFile: open.topic ?? "" } }),
    AlertConfigError,
  );
  for (const bad of [
    "http://ntfy.example.invalid/x",
    "https://user:pw@ntfy.example.invalid/x",
    "not a url",
  ]) {
    const f = await files(t, { topic: bad });
    await assert.rejects(
      createNotifier({ ntfy: { topicUrlFile: f.topic ?? "" } }),
      (error: Error) => error instanceof AlertConfigError && !error.message.includes(bad),
    );
  }
});

test("pushes go to the ntfy topic with title, priority, and token; heartbeats to healthchecks", async (t) => {
  const f = await files(t, { topic: `${TOPIC}\n`, token: "tk_synthetic\n", ping: `${PING}/\n` });
  const r = recorder();
  const notifier = await createNotifier(
    {
      ntfy: { topicUrlFile: f.topic ?? "", tokenFile: f.token ?? "" },
      healthchecks: { pingUrlFile: f.ping ?? "" },
    },
    { fetch: r.impl },
  );
  notifier.notify({
    priority: "urgent",
    title: "BoC 2026: day-01 check failed ✗",
    message: "line 1\nline 2\u0007",
  });
  notifier.heartbeat(true);
  notifier.heartbeat(false);
  await notifier.flush();
  const [push, ok, fail] = r.requests;
  assert.equal(push?.url, TOPIC);
  assert.equal(push?.method, "POST");
  assert.equal(push?.headers.get("title"), "BoC 2026: day-01 check failed ?");
  assert.equal(push?.headers.get("priority"), "5");
  assert.equal(push?.headers.get("authorization"), "Bearer tk_synthetic");
  assert.equal(push?.body, "line 1\nline 2", "control characters are stripped");
  assert.equal(ok?.url, PING);
  assert.equal(fail?.url, `${PING}/fail`);
});

test("alerts are deduplicated and rate limited, and delivery failures never throw", async (t) => {
  const f = await files(t, { topic: TOPIC });
  let now = 0;
  const r = recorder(500);
  const logged: string[] = [];
  const notifier = await createNotifier(
    { ntfy: { topicUrlFile: f.topic ?? "" } },
    { fetch: r.impl, now: () => now, log: (m) => logged.push(m) },
  );
  const same = { priority: "high" as const, title: "t", message: "m" };
  notifier.notify(same);
  notifier.notify(same);
  now += 11 * 60_000;
  notifier.notify(same);
  await notifier.flush();
  assert.equal(r.requests.length, 2, "a duplicate within 10 minutes is dropped");
  assert.ok(
    logged.every((m) => m === "alert delivery failed (HTTP 500)"),
    "no destination in logs",
  );
  for (let i = 0; i < 40; i++)
    notifier.notify({ priority: "default", title: "t", message: `m${i}` });
  await notifier.flush();
  assert.equal(r.requests.length, 30, "at most 30 per hour");
  now += 61 * 60_000;
  notifier.notify({ priority: "default", title: "t", message: "after" });
  await notifier.flush();
  const last = r.requests.slice(-2);
  assert.equal(last[0]?.headers.get("title"), "BoC: alerts suppressed");
  assert.match(last[0]?.body ?? "", /12 alert\(s\) were suppressed/);
  assert.equal(last[1]?.body, "after");
});

test("a hanging destination cannot hold up a run: flush is bounded", async (t) => {
  const f = await files(t, { topic: TOPIC });
  const hanging = (() => new Promise<Response>(() => {})) as typeof fetch;
  const notifier = await createNotifier(
    { ntfy: { topicUrlFile: f.topic ?? "" } },
    { fetch: hanging },
  );
  notifier.notify({ priority: "low", title: "t", message: "m" });
  const started = Date.now();
  await notifier.flush(50);
  assert.ok(Date.now() - started < 1_000);
});
