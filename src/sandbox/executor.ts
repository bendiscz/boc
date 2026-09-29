import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Generated-code execution boundary (D010). The production implementation runs
 * networkless, non-root, read-only-root, resource-limited containers with the
 * attempt workspace mounted read-only at /work and a bounded exec-enabled tmpfs
 * for build output and scratch. No host environment, credentials, Docker socket,
 * or network reach the container.
 *
 * `run` starts a fresh container per command. A session (D030) keeps one such
 * container per attempt and runs each command with `docker exec`, which saves the
 * container start (about 0.35 s per run on a Raspberry Pi 5). Commands of one
 * attempt then share /tmp; a timeout or abort kills the whole container, and the
 * next command starts a fresh one.
 */

export interface RunRequest {
  /** Host path of the attempt workspace (mounted read-only at /work). */
  readonly workspace: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  /** Aborting kills the container immediately. */
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface Executor {
  run(request: RunRequest): Promise<RunResult>;
  /** One warm container for an attempt's commands (D030); started at once. */
  openSession?(workspace: string): ExecutorSession;
  /** Remove containers left behind by a crashed process. */
  cleanup?(): Promise<void>;
}

export interface ExecutorSession {
  run(request: Omit<RunRequest, "workspace">): Promise<RunResult>;
  close(): Promise<void>;
}

/** Label of every solver container, so a restart can remove leftovers. */
export const CONTAINER_LABEL = "boc.solver=1";

export interface DockerExecutorOptions {
  /** Operator-trusted image: a local image ID (sha256:...) or name@sha256:digest. */
  readonly image: string;
  readonly docker?: string;
  readonly memory?: string;
  readonly cpus?: string;
  readonly pids?: number;
  readonly scratch?: string;
  readonly maxOutputBytes?: number;
  readonly maxTimeoutMs?: number;
}

const IMAGE_PATTERN = /^(sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]{0,199}@sha256:[a-f0-9]{64})$/;
const ARG_PATTERN = /^[\x20-\x7e]{1,500}$/;

/** Fixed, non-secret environment inside the container. */
const CONTAINER_ENV: Readonly<Record<string, string>> = {
  HOME: "/tmp/home",
  TMPDIR: "/tmp",
  PATH: "/usr/local/cargo/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin",
  GOCACHE: "/tmp/go-cache",
  GOPATH: "/tmp/go",
  GOFLAGS: "-mod=mod",
  GOPROXY: "off",
  CARGO_HOME: "/tmp/cargo",
  CARGO_TARGET_DIR: "/tmp/target",
  CARGO_NET_OFFLINE: "true",
  UV_OFFLINE: "1",
  UV_CACHE_DIR: "/tmp/uv-cache",
  PYTHONDONTWRITEBYTECODE: "1",
  NODE_OPTIONS: "--max-old-space-size=1536",
};

/** Minimal host environment for the Docker CLI itself; never forwarded into the container. */
function dockerClientEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function checkArgv(argv: readonly string[]): void {
  if (argv.length === 0 || argv.length > 32) throw new Error("Invalid command.");
  if (!argv.every((a) => ARG_PATTERN.test(a))) throw new Error("Invalid command.");
}

export function dockerArgs(
  options: DockerExecutorOptions,
  request: RunRequest,
  name: string,
): string[] {
  checkArgv(request.argv);
  return [...containerArgs(options, request.workspace, name), options.image, ...request.argv];
}

/** `docker run -d` of a session container that idles until commands are exec'd. */
export function dockerSessionArgs(
  options: DockerExecutorOptions,
  workspace: string,
  name: string,
): string[] {
  const args = containerArgs(options, workspace, name);
  // --init reaps the exec'd processes; `sleep infinity` keeps the container alive.
  args.splice(1, 0, "--detach", "--init");
  return [...args, options.image, "sleep", "infinity"];
}

/** `docker exec` of one command in a session container (same user, env, and /work). */
export function dockerExecArgs(name: string, argv: readonly string[]): string[] {
  checkArgv(argv);
  return ["exec", "--user=65534:65534", "--workdir=/work", name, ...argv];
}

function containerArgs(options: DockerExecutorOptions, workspace: string, name: string): string[] {
  if (!IMAGE_PATTERN.test(options.image)) throw new Error("Image must be pinned by digest.");
  if (!workspace.startsWith("/") || /[,:\n]/.test(workspace)) {
    throw new Error("Invalid workspace path.");
  }
  const args = [
    "run",
    "--rm",
    `--name=${name}`,
    `--label=${CONTAINER_LABEL}`,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--pids-limit=${options.pids ?? 256}`,
    `--memory=${options.memory ?? "2g"}`,
    `--memory-swap=${options.memory ?? "2g"}`,
    `--cpus=${options.cpus ?? "2"}`,
    "--user=65534:65534",
    "--ipc=none",
    `--mount=type=bind,source=${workspace},target=/work,readonly`,
    `--tmpfs=/tmp:rw,exec,nosuid,nodev,size=${options.scratch ?? "1g"},uid=65534,gid=65534,mode=700`,
    "--workdir=/work",
    "--entrypoint=",
  ];
  for (const [key, value] of Object.entries(CONTAINER_ENV)) args.push("--env", `${key}=${value}`);
  return args;
}

export function createDockerExecutor(options: DockerExecutorOptions): Executor {
  const docker = options.docker ?? "docker";
  const maxOutput = options.maxOutputBytes ?? 64 * 1024;
  const maxTimeout = options.maxTimeoutMs ?? 120_000;
  const limit = (ms: number) => Math.min(Math.max(1_000, ms), maxTimeout);
  const kill = (name: string) =>
    new Promise<void>((resolve) => {
      spawn(docker, ["rm", "-f", name], { env: dockerClientEnv(), stdio: "ignore" })
        .on("error", () => resolve())
        .on("close", () => resolve());
    });
  const invoke = (
    args: string[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    stop: () => void,
  ) => runCli(docker, args, { timeoutMs, maxOutput, ...(signal ? { signal } : {}), stop });

  return {
    run(request) {
      const name = `boc-${randomUUID()}`;
      const args = dockerArgs(options, request, name);
      // Kill the container, not just the CLI; --rm then removes it.
      return invoke(args, limit(request.timeoutMs), request.signal, () => void kill(name));
    },

    openSession(workspace) {
      let name = "";
      let ready: Promise<boolean> | undefined;
      let closed = false;
      const start = () => {
        name = `boc-${randomUUID()}`;
        const args = dockerSessionArgs(options, workspace, name);
        const current = name;
        ready = invoke(args, 60_000, undefined, () => void kill(current)).then(
          (r) => r.exitCode === 0 && !r.timedOut,
        );
        return ready;
      };
      void start();
      return {
        async run(request) {
          if (closed) throw new Error("Session closed.");
          const started = Date.now();
          let up = await (ready ?? start());
          if (!up) up = await start(); // One retry, e.g. after a killed container.
          if (!up) {
            return {
              exitCode: null,
              timedOut: false,
              stdout: "",
              stderr: "The solver container could not be started.",
              truncated: false,
              durationMs: Date.now() - started,
            };
          }
          const current = name;
          let killed = false;
          const result = await invoke(
            dockerExecArgs(current, request.argv),
            limit(request.timeoutMs),
            request.signal,
            () => {
              // An exec'd process survives its CLI: kill the whole container.
              killed = true;
              void kill(current);
            },
          );
          if (killed) ready = undefined; // The next command gets a fresh container.
          return result;
        },
        async close() {
          closed = true;
          if (await ready?.catch(() => false)) await kill(name);
        },
      };
    },

    async cleanup() {
      const ids = await runCli(docker, ["ps", "-aq", "--filter", `label=${CONTAINER_LABEL}`], {
        timeoutMs: 30_000,
        maxOutput: 64 * 1024,
        stop: () => {},
      });
      for (const id of ids.stdout.split("\n").filter((x) => /^[a-f0-9]{12,64}$/.test(x))) {
        await kill(id);
      }
    },
  };
}

/** Spawn the Docker CLI with bounded output, a timeout, and abort handling. */
function runCli(
  docker: string,
  args: string[],
  options: {
    readonly timeoutMs: number;
    readonly maxOutput: number;
    readonly signal?: AbortSignal;
    readonly stop: () => void;
  },
): Promise<RunResult> {
  const started = Date.now();
  return new Promise<RunResult>((resolve) => {
    const child = spawn(docker, args, {
      env: dockerClientEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    const collect = (chunks: Buffer[], add: (n: number) => number) => (chunk: Buffer) => {
      const room = options.maxOutput - add(0);
      if (room <= 0) {
        truncated = true;
        return;
      }
      const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      if (part.byteLength < chunk.byteLength) truncated = true;
      chunks.push(part);
      add(part.byteLength);
    };
    child.stdout.on(
      "data",
      collect(out, (n) => (outBytes += n)),
    );
    child.stderr.on(
      "data",
      collect(err, (n) => (errBytes += n)),
    );
    const stop = () => {
      options.stop();
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => stop();
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    let finished = false;
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        timedOut,
        stdout: sanitize(Buffer.concat(out).toString("utf8")),
        stderr: sanitize(Buffer.concat(err).toString("utf8")),
        truncated,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Neutralize terminal control characters in program output: strip CSI/OSC escape
 * sequences and CR, replace other C0/C1/DEL controls, keep tab and newline.
 */
export function sanitize(text: string): string {
  let result = "";
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? "";
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x1b) {
      const next = chars[i + 1];
      if (next === "[") {
        // CSI: parameters/intermediates until a final byte in @..~ (bounded scan).
        let j = i + 2;
        while (j < chars.length && j < i + 64 && !/[@-~]/.test(chars[j] ?? "")) j++;
        i = j;
      } else if (next === "]") {
        // OSC: until BEL or ESC \ (bounded scan).
        let j = i + 2;
        while (j < chars.length && j < i + 512 && chars[j] !== "\x07" && chars[j] !== "\x1b") j++;
        i = chars[j] === "\x1b" ? j + 1 : j;
      } else {
        i++;
      }
      continue;
    }
    if (code === 0x09 || code === 0x0a) result += char;
    else if (code === 0x0d) continue;
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) result += "\uFFFD";
    else result += char;
  }
  return result;
}
