import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger, type LogLevel } from "../log.ts";
import { VaultService, type VaultServiceOptions } from "./service.ts";

/** Logger that keeps lines instead of printing them. */
export function memoryLogger(level: LogLevel = "warn") {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level,
    write: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

/** A vault service over a throwaway folder; `dispose` stops it and deletes the folder. */
export async function tempVaults(options: Partial<VaultServiceOptions> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "palimvo-vaults-"));
  const root = path.join(dir, "vaults");
  const { logger, lines } = memoryLogger();
  const vaults = new VaultService(root, { logger, ...options });
  await vaults.init();
  return {
    vaults,
    dir,
    root,
    logs: lines,
    dispose: async () => {
      await vaults.idle();
      vaults.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
