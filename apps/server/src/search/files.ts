import { AppError, fileKind, type FileContent } from "@palimvo/core";
import type { VaultService } from "../vault/service.ts";

/** Files read from disk at once when they are not in memory yet. */
const READ_CONCURRENCY = 32;

/** The way search and links get at one vault's files; the vault service is the real one. */
export interface FileSource {
  list(vault: string): Promise<readonly string[]>;
  cached(vault: string, path: string): FileContent | undefined;
  read(vault: string, path: string): Promise<FileContent>;
}

export function vaultFileSource(vaults: VaultService): FileSource {
  return {
    list: (vault) => vaults.listFiles(vault),
    cached: (vault, path) => vaults.cachedFile(vault, path),
    read: (vault, path) => vaults.readFile(vault, path),
  };
}

/**
 * Calls `visit` for every note, canvas and base among `paths`, in order, with its file (null for
 * a file that vanished meanwhile). Files already in memory need no await (thousands of awaits cost
 * more than the scan itself); the rest are read a few at a time.
 */
export async function eachFile(
  source: FileSource,
  vault: string,
  paths: readonly string[],
  visit: (path: string, file: FileContent | null) => void,
): Promise<void> {
  const files = new Map<string, FileContent | null>();
  const missing: string[] = [];
  for (const path of paths) {
    if (fileKind(path) === "other") continue;
    const hit = source.cached(vault, path);
    if (hit) files.set(path, hit);
    else missing.push(path);
  }
  for (let i = 0; i < missing.length; i += READ_CONCURRENCY) {
    await Promise.all(
      missing.slice(i, i + READ_CONCURRENCY).map(async (path) => {
        files.set(
          path,
          await source.read(vault, path).catch((err: unknown) => {
            if (err instanceof AppError && err.code === "not_found") return null;
            throw err;
          }),
        );
      }),
    );
  }
  for (const path of paths) if (files.has(path)) visit(path, files.get(path) ?? null);
}
