import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError, type FileContent } from "@palimvo/core";
import { errnoCode } from "./atomic.ts";

export {
  TEMP_FILE,
  atomicWrite,
  errnoCode,
  renameRetrying,
  tempName,
  writeTemp,
} from "./atomic.ts";

/** Largest text file read into memory or accepted as text in one write (matches the upload default). */
export const MAX_TEXT_BYTES = 64 * 1024 * 1024;

export function bytesVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export function contentVersion(content: string): string {
  return bytesVersion(Buffer.from(content, "utf8"));
}

/** The file system said "nothing there" (or something on the way is a file, not a folder). */
export function isMissing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Turns file system errors a client can cause into API errors; anything else is returned unchanged. */
export function mapFsError(err: unknown, rel: string): unknown {
  switch (errnoCode(err)) {
    case "ENOENT":
    case "ENOTDIR":
    case "EISDIR":
      return new AppError("not_found", undefined, { path: rel });
    case "EEXIST":
    case "ENOTEMPTY":
      return new AppError("already_exists", undefined, { path: rel });
    default:
      return err;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** The bytes and modification time of a file, or null when there is no such file (a folder counts as none). */
export async function readBytesIfExists(
  abs: string,
): Promise<{ bytes: Buffer; mtime: number } | null> {
  try {
    const info = await stat(abs);
    if (!info.isFile()) return null;
    return { bytes: await readFile(abs), mtime: info.mtimeMs };
  } catch (err) {
    if (isMissing(err) || errnoCode(err) === "EISDIR") return null;
    throw err;
  }
}

/** A text file's content and version, or null when it does not exist. */
export async function readIfExists(abs: string, rel: string): Promise<FileContent | null> {
  try {
    const info = await stat(abs);
    if (!info.isFile()) return null;
    if (info.size > MAX_TEXT_BYTES) {
      throw new AppError("payload_too_large", undefined, { path: rel, limit: MAX_TEXT_BYTES });
    }
    const bytes = await readFile(abs);
    return {
      path: rel,
      content: bytes.toString("utf8"),
      mtime: info.mtimeMs,
      version: bytesVersion(bytes),
    };
  } catch (err) {
    if (isMissing(err) || errnoCode(err) === "EISDIR") return null;
    throw err;
  }
}

/** Resolves symlinks of the nearest existing ancestor and appends the rest, so a path that does not exist yet can be checked. */
export async function realpathOfNearestExisting(p: string): Promise<string> {
  let current = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch (err) {
      if (!isMissing(err)) throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
