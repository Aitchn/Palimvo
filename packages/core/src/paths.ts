import type { FileKind } from "./types.ts";

export class InvalidPathError extends Error {
  constructor(path: string, reason: string) {
    super(`Invalid vault path "${path}": ${reason}`);
    this.name = "InvalidPathError";
  }
}

/**
 * Names inside a vault that clients may never read or write directly. `.aivault` is the
 * folder of the previous product; it stays reserved so its metadata cannot be touched
 * while legacy data is waiting to be migrated.
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([".git", ".palimvo", ".aivault"]);

/** Device names Windows refuses as file names, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
const INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** Longest accepted path and path segment, in UTF-16 units (the common filesystem limits). */
export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_LENGTH = 255;

/**
 * Normalizes a client-supplied vault-relative path and rejects anything that
 * could escape the vault, touch reserved folders, or not exist on Windows.
 */
export function normalizeVaultPath(input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new InvalidPathError(String(input), "empty path");
  }
  if (input.length > MAX_PATH_LENGTH)
    throw new InvalidPathError(input.slice(0, 40) + "…", "path is too long");
  if (input.includes("\0")) throw new InvalidPathError(input, "null byte");
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) {
    throw new InvalidPathError(input, "absolute paths are not allowed");
  }
  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new InvalidPathError(input, "parent traversal is not allowed");
    // Windows ignores case and trailing dots/spaces, and a colon addresses an NTFS stream.
    // None of that may bypass the private metadata boundary.
    const alias = segment
      .toLowerCase()
      .split(":", 1)[0]!
      .replace(/[ .]+$/, "");
    if (RESERVED_SEGMENTS.has(alias)) throw new InvalidPathError(input, `"${segment}" is reserved`);
    if (INVALID_CHARS.test(segment))
      throw new InvalidPathError(input, `"${segment}" has characters that are not allowed`);
    if (/[ .]$/.test(segment))
      throw new InvalidPathError(input, `"${segment}" ends with a space or dot`);
    if (WINDOWS_DEVICE_NAME.test(segment.split(".", 1)[0]!)) {
      throw new InvalidPathError(input, `"${segment}" is a reserved device name`);
    }
    if (segment.length > MAX_SEGMENT_LENGTH)
      throw new InvalidPathError(input, "a name is too long");
    segments.push(segment);
  }
  if (segments.length === 0) throw new InvalidPathError(input, "empty path");
  return segments.join("/");
}

/** Vault ids are folder names under the vaults root: letters, digits, dash, underscore. */
export function isValidVaultId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) && !WINDOWS_DEVICE_NAME.test(id);
}

/**
 * The key two paths must share to name the same file on every supported filesystem
 * (Windows and macOS ignore case). Use it for Map keys and equality checks.
 */
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** The folder part of a normalized path ("" for the vault root). */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The last segment of a normalized path. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Joins normalized parts, skipping empty ones. The result is not re-validated. */
export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

/** Whether `path` is `folder` itself or inside it (case-insensitive). */
export function isInside(path: string, folder: string): boolean {
  if (folder === "") return true;
  const p = pathKey(path);
  const f = pathKey(folder);
  return p === f || p.startsWith(`${f}/`);
}

export function fileKind(path: string): FileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".canvas")) return "canvas";
  if (lower.endsWith(".base")) return "base";
  return "other";
}

export type MediaKind = "image" | "audio" | "video";

/** Media files the app shows and plays, by extension, with the type they are served as. */
export const MEDIA_TYPES: Readonly<Record<string, { kind: MediaKind; type: string }>> = {
  png: { kind: "image", type: "image/png" },
  jpg: { kind: "image", type: "image/jpeg" },
  jpeg: { kind: "image", type: "image/jpeg" },
  gif: { kind: "image", type: "image/gif" },
  webp: { kind: "image", type: "image/webp" },
  avif: { kind: "image", type: "image/avif" },
  bmp: { kind: "image", type: "image/bmp" },
  ico: { kind: "image", type: "image/x-icon" },
  apng: { kind: "image", type: "image/apng" },
  jfif: { kind: "image", type: "image/jpeg" },
  mp3: { kind: "audio", type: "audio/mpeg" },
  ogg: { kind: "audio", type: "audio/ogg" },
  oga: { kind: "audio", type: "audio/ogg" },
  wav: { kind: "audio", type: "audio/wav" },
  m4a: { kind: "audio", type: "audio/mp4" },
  aac: { kind: "audio", type: "audio/aac" },
  flac: { kind: "audio", type: "audio/flac" },
  opus: { kind: "audio", type: "audio/ogg" },
  weba: { kind: "audio", type: "audio/webm" },
  mp4: { kind: "video", type: "video/mp4" },
  webm: { kind: "video", type: "video/webm" },
  mov: { kind: "video", type: "video/quicktime" },
  m4v: { kind: "video", type: "video/mp4" },
  ogv: { kind: "video", type: "video/ogg" },
};

/** The media entry for a path, or undefined for anything else (SVG included: it can carry scripts). */
export function mediaOf(path: string): { kind: MediaKind; type: string } | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : MEDIA_TYPES[path.slice(dot + 1).toLowerCase()];
}
