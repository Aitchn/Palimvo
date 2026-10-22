import { stat } from "node:fs/promises";
import path from "node:path";
import { LEGACY_VAULT_META_DIR, VAULT_META_DIR, createMigrator } from "@palimvo/core";
import { errorFields } from "../errors.ts";
import type { Logger } from "../log.ts";
import { renameRetrying } from "./fsutil.ts";

/** The vault's own settings file inside `.palimvo/`. */
export const VAULT_CONFIG_FILE = "config.json";

export interface VaultConfig extends Record<string, unknown> {
  schemaVersion: number;
  createdAt: string;
}

export const VAULT_CONFIG_VERSION = 1;

/** Upgrades older `config.json` content; future versions add steps here. */
export const migrateVaultConfig = createMigrator<VaultConfig>({
  current: VAULT_CONFIG_VERSION,
  migrations: [],
});

export function newVaultConfig(now: Date = new Date()): VaultConfig {
  return { schemaVersion: VAULT_CONFIG_VERSION, createdAt: now.toISOString() };
}

/** Reads and upgrades the text of a `config.json`. Throws `schema_invalid` / `schema_too_new`. */
export function parseVaultConfig(text: string): VaultConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  return migrateVaultConfig(value).data;
}

/**
 * A vault written by the previous product keeps its settings in `.aivault/`. Renames that folder
 * to `.palimvo/`; returns true if it did. When both exist nothing is touched (a person must decide).
 */
export async function migrateLegacyMeta(vaultDir: string, log: Logger): Promise<boolean> {
  const legacy = path.join(vaultDir, LEGACY_VAULT_META_DIR);
  const current = path.join(vaultDir, VAULT_META_DIR);
  if (!(await isFolder(legacy))) return false;
  if (
    await stat(current).then(
      () => true,
      () => false,
    )
  ) {
    log.warn("vault has both .aivault and .palimvo; leaving both as they are", { dir: vaultDir });
    return false;
  }
  try {
    await renameRetrying(legacy, current);
  } catch (err) {
    log.error("could not rename .aivault to .palimvo", { dir: vaultDir, ...errorFields(err) });
    return false;
  }
  log.info("renamed .aivault to .palimvo", { dir: vaultDir });
  return true;
}

async function isFolder(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
