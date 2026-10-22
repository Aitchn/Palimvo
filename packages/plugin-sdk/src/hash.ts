import { MANIFEST_FILE } from "./manifest.ts";

/**
 * The content hash a person approves. It covers every file of the package (manifest, code,
 * styles, locales, README), so changing a single byte anywhere gives a new hash and the plugin
 * needs approval again.
 *
 * Rule (version 1): SHA-256, lower-case hex, over
 *
 *     "palimvo-plugin-hash-v1\0"
 *     then, for each file sorted by the UTF-8 bytes of its path:
 *       uint32-BE length of the UTF-8 path, the path, uint64-BE byte length, the bytes
 *
 * Paths are relative to the package root with `/` separators and must include `manifest.json`.
 * Bytes are hashed as stored: line endings are not normalized.
 */

export const PLUGIN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const HEADER = "palimvo-plugin-hash-v1\0";

export interface PluginFile {
  path: string;
  bytes: Uint8Array;
}

interface SubtleLike {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

function subtle(): SubtleLike {
  const s = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (!s) throw new Error("Web Crypto (crypto.subtle) is not available in this environment.");
  return s;
}

function checkPath(path: string): void {
  const bad =
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((s) => s === "" || s === "." || s === "..");
  if (bad) throw new Error(`Invalid plugin file path: ${JSON.stringify(path)}`);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Hash of a whole package; throws on duplicate or unsafe paths or a missing `manifest.json`. */
export async function computePluginHash(files: readonly PluginFile[]): Promise<string> {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    checkPath(f.path);
    return { path: encoder.encode(f.path), name: f.path, bytes: f.bytes };
  });
  if (!entries.some((e) => e.name === MANIFEST_FILE)) {
    throw new Error(`A plugin package must contain ${MANIFEST_FILE}.`);
  }
  entries.sort((a, b) => compareBytes(a.path, b.path));
  for (let i = 1; i < entries.length; i++) {
    if ((entries[i] as { name: string }).name === (entries[i - 1] as { name: string }).name) {
      throw new Error(`Duplicate plugin file path: ${(entries[i] as { name: string }).name}`);
    }
  }
  const header = encoder.encode(HEADER);
  let total = header.length;
  for (const e of entries) total += 4 + e.path.length + 8 + e.bytes.length;
  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);
  buffer.set(header, 0);
  let offset = header.length;
  for (const e of entries) {
    view.setUint32(offset, e.path.length);
    buffer.set(e.path, offset + 4);
    offset += 4 + e.path.length;
    view.setBigUint64(offset, BigInt(e.bytes.length));
    buffer.set(e.bytes, offset + 8);
    offset += 8 + e.bytes.length;
  }
  const digest = new Uint8Array(await subtle().digest("SHA-256", buffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
