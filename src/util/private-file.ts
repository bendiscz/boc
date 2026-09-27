import { open } from "node:fs/promises";

export class PrivateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateFileError";
  }
}

/**
 * Read a secret-bearing file: must be a regular file owned by the current user
 * with no group/other permissions. Errors never include the path or content.
 */
export async function readPrivateFile(path: string, maxBytes = 64 * 1024): Promise<string> {
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
      throw new PrivateFileError("Credential file must be a regular owner-only (0600) file.");
    }
    if (info.size > maxBytes) throw new PrivateFileError("Credential file is too large.");
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof PrivateFileError) throw error;
    throw new PrivateFileError("Cannot read the credential file.");
  } finally {
    await handle?.close().catch(() => {});
  }
}
