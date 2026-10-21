/**
 * Every on-disk, wire and browser-storage identifier Palimvo owns, in one place.
 * The `LEGACY_*` values are the names used by Obsidian-Aitchn; they exist only so
 * old data can be read and migrated, and are removed in 1.0.
 */

export const PRODUCT_NAME = "Palimvo";
export const MCP_SERVER_NAME = "palimvo";

/** Folder inside a vault that holds Palimvo's own settings, plugins and proposals. */
export const VAULT_META_DIR = ".palimvo";
export const LEGACY_VAULT_META_DIR = ".aivault";

export const AUTHOR_HEADER = "x-palimvo-author";
export const REASON_HEADER = "x-palimvo-reason";
export const LEGACY_AUTHOR_HEADER = "x-aivault-author";
export const LEGACY_REASON_HEADER = "x-aivault-reason";

/** Git trailers written into every commit message. */
export const GIT_AUTHOR_TRAILER = "Palimvo-Author";
export const GIT_REASON_TRAILER = "Palimvo-Reason";

/** Domain of the synthetic e-mail addresses used for non-human git authors. */
export const GIT_EMAIL_DOMAIN = "palimvo.local";

/** Prefix shared by every server environment variable. */
export const ENV_PREFIX = "PALIMVO_";
export const ENV = {
  dataDir: "PALIMVO_DATA_DIR",
  host: "PALIMVO_HOST",
  port: "PALIMVO_PORT",
  publicUrl: "PALIMVO_PUBLIC_URL",
  trustProxy: "PALIMVO_TRUST_PROXY",
  logLevel: "PALIMVO_LOG_LEVEL",
} as const;

export const NPM_SCOPE = "@palimvo";

/** Browser storage keys (localStorage / IndexedDB). */
export const STORAGE_KEYS = {
  theme: "palimvo.theme",
  locale: "palimvo.locale",
  outbox: "palimvo.outbox",
  unsentPrefix: "palimvo.unsent:",
  docDbPrefix: "palimvo-doc:",
} as const;

export const LEGACY_STORAGE_KEYS = {
  theme: "aitchn.theme",
  outbox: "cairn-outbox",
  unsentPrefix: "cairn-unsent:",
  docDbPrefix: "cairn-doc:",
} as const;

/** Old name -> new name, for one-time browser storage migration. */
export const STORAGE_KEY_RENAMES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  [LEGACY_STORAGE_KEYS.theme, STORAGE_KEYS.theme],
  [LEGACY_STORAGE_KEYS.outbox, STORAGE_KEYS.outbox],
];

/** Case-insensitively reads a request header under its current or legacy name. */
export function readCompatHeader(
  get: (name: string) => string | null | undefined,
  current: string,
  legacy: string,
): string | null {
  return get(current) ?? get(legacy) ?? null;
}

/** Maps a path inside a vault from the legacy meta folder to the current one; other paths pass through. */
export function migrateLegacyMetaPath(path: string): string {
  if (path === LEGACY_VAULT_META_DIR) return VAULT_META_DIR;
  if (path.startsWith(`${LEGACY_VAULT_META_DIR}/`)) {
    return VAULT_META_DIR + path.slice(LEGACY_VAULT_META_DIR.length);
  }
  return path;
}

/** True for the vault meta folder (current or legacy) and anything under it. */
export function isVaultMetaPath(path: string): boolean {
  return [VAULT_META_DIR, LEGACY_VAULT_META_DIR].some(
    (dir) => path === dir || path.startsWith(`${dir}/`),
  );
}
