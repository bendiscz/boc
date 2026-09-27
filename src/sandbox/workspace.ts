import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/**
 * Host-side per-attempt workspace. Only trusted host code (the solver tools)
 * writes here; the container sees it read-only, so generated code cannot plant
 * symlinks. Host operations still refuse symlinks and path tricks, and bound
 * sizes, because tool arguments come from the model.
 */

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 64;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function validateRelativePath(path: string): string[] {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) {
    throw new WorkspaceError("Invalid path.");
  }
  const segments = path.split("/");
  if (segments.length > 4 || segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) {
    throw new WorkspaceError(
      "Paths must be relative, up to 4 segments of letters, digits, '.', '_' or '-'.",
    );
  }
  return segments;
}

export interface WorkspaceEntry {
  readonly path: string;
  readonly size: number;
}

export class Workspace {
  readonly root: string;
  /** Files placed by the orchestrator (e.g. input.txt) that tools may not overwrite. */
  readonly #protected: ReadonlySet<string>;

  /**
   * Create an attempt workspace. The directory itself is 0755 so the container's
   * unprivileged UID can read it on Linux bind mounts; confidentiality comes from
   * the private (0700) storage directories above it.
   */
  static async create(root: string, protectedFiles: readonly string[] = []): Promise<Workspace> {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);
    return new Workspace(root, protectedFiles);
  }

  constructor(root: string, protectedFiles: readonly string[] = []) {
    this.root = root;
    this.#protected = new Set(protectedFiles);
  }

  async #checkParents(segments: string[], create: boolean): Promise<string> {
    let current = this.root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (!info.isDirectory()) throw new WorkspaceError("Path component is not a directory.");
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        if (!create) throw new WorkspaceError("No such file.");
        await mkdir(current, { mode: 0o755 }).catch(() => {
          throw new WorkspaceError("Cannot create directory.");
        });
      }
    }
    return join(current, segments.at(-1) ?? "");
  }

  async write(path: string, content: string): Promise<void> {
    const segments = validateRelativePath(path);
    if (this.#protected.has(path)) throw new WorkspaceError("This file is read-only.");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new WorkspaceError("File too large.");
    const entries = await this.list();
    const existing = entries.find((e) => e.path === path);
    const total = entries.reduce((sum, e) => sum + e.size, 0) - (existing?.size ?? 0) + bytes;
    if (total > MAX_WORKSPACE_BYTES || (!existing && entries.length >= MAX_FILES)) {
      throw new WorkspaceError("Workspace limit reached.");
    }
    const target = await this.#checkParents(segments, true);
    // O_NOFOLLOW: never write through a symlink even if one appeared.
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    ).catch(() => {
      throw new WorkspaceError("Cannot write file.");
    });
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  }

  /** Place an orchestrator-owned file (e.g. the puzzle input) without size limits for tools. */
  async place(path: string, content: string): Promise<void> {
    const segments = validateRelativePath(path);
    const target = await this.#checkParents(segments, true);
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  }

  /** Read a text slice by lines; bounded so the model context stays manageable. */
  async read(
    path: string,
    offsetLine = 0,
    maxLines = 200,
  ): Promise<{ text: string; totalLines: number }> {
    const segments = validateRelativePath(path);
    const target = await this.#checkParents(segments, false);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
      throw new WorkspaceError("No such file.");
    });
    let content: string;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new WorkspaceError("Not a regular file.");
      if (info.size > MAX_WORKSPACE_BYTES) throw new WorkspaceError("File too large to read.");
      content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const lines = content.split("\n");
    const start = Math.max(0, Math.floor(offsetLine));
    const count = Math.min(Math.max(1, Math.floor(maxLines)), 500);
    const slice = lines
      .slice(start, start + count)
      .map((line) => (line.length > 2_000 ? `${line.slice(0, 2_000)}…[line truncated]` : line));
    return { text: slice.join("\n"), totalLines: lines.length };
  }

  async list(): Promise<WorkspaceEntry[]> {
    const result: WorkspaceEntry[] = [];
    const walk = async (directory: string, depth: number) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
        else if (entry.isFile()) {
          const info = await lstat(full);
          result.push({ path: relative(this.root, full).split(sep).join("/"), size: info.size });
        }
      }
    };
    await walk(this.root, 1);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
}
