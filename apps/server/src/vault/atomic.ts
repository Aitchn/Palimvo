import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

// Kept free of project imports so crash tests can run it in a bare child process.

const TEMP_MARKER = ".tmp-";
/** Exactly the names `atomicWrite` generates: ".<basename>.tmp-<8 hex>". Nothing else is ever deleted. */
export const TEMP_FILE = /^\.[\s\S]+\.tmp-[0-9a-f]{8}$/; // [\s\S]: file names may contain line breaks

export function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Writes to a hidden temp file in the same folder, fsyncs it, then renames over the target, so a
 * crash leaves either the old or the new content, never a mix. The folder itself is not fsynced.
 */
export async function atomicWrite(abs: string, content: string | Uint8Array): Promise<void> {
  const temp = tempName(abs);
  await writeTemp(temp, content);
  try {
    await renameRetrying(temp, abs);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}

export function tempName(abs: string): string {
  return path.join(
    path.dirname(abs),
    `.${path.basename(abs)}${TEMP_MARKER}${randomBytes(4).toString("hex")}`,
  );
}

export async function writeTemp(temp: string, content: string | Uint8Array): Promise<void> {
  const handle = await open(temp, "w");
  try {
    await (typeof content === "string"
      ? handle.writeFile(content, "utf8")
      : handle.writeFile(content));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * On Windows a file or folder cannot be renamed while something (an editor, antivirus, a git
 * process) briefly holds it open; try again for a few seconds.
 */
export async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = errnoCode(err);
      if (attempt >= 8 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** Math.min(attempt, 4)));
    }
  }
}
