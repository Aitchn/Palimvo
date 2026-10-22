import type { Author } from "@palimvo/core";
import { VAULT_META_DIR } from "@palimvo/core";
import type { ChangeNote, ChangeRecorder } from "../history/history.ts";
import { parseVaultConfig, VAULT_CONFIG_FILE } from "../vault/meta.ts";
import type { VaultService } from "../vault/service.ts";

/** Where in a vault's `config.json` the plugin-tool settings live. */
const KEY = "pluginTools";

export interface PluginToolSettings {
  /** List the plugin tools in `tools/list` of `/mcp/<vault>` instead of only behind `list_tools`. */
  listed: boolean;
}

const CACHE_MS = 2000;

/**
 * A vault's settings for how its plugin tools reach AI clients. They are part of the vault
 * (`.palimvo/config.json`), so they travel with it. `toolsFor` is synchronous, so the provider
 * loads them in `prepare` and keeps them for a moment.
 */
export class PluginToolSettingsStore {
  private readonly cache = new Map<string, { at: number; value: PluginToolSettings }>();

  constructor(
    private readonly vaults: Pick<VaultService, "readMetaBytes" | "modifyMeta">,
    private readonly history: ChangeRecorder,
    private readonly now: () => number = Date.now,
  ) {}

  /** Last loaded value; call {@link load} first. */
  cached(vault: string): PluginToolSettings {
    return this.cache.get(vault)?.value ?? { listed: false };
  }

  async load(vault: string): Promise<PluginToolSettings> {
    const hit = this.cache.get(vault);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.value;
    const value = await this.read(vault);
    this.cache.set(vault, { at: this.now(), value });
    return value;
  }

  async set(
    vault: string,
    settings: PluginToolSettings,
    by: { author: Author; note?: ChangeNote },
  ): Promise<PluginToolSettings> {
    await this.vaults.modifyMeta(
      vault,
      VAULT_CONFIG_FILE,
      (text) => {
        if (text === null) throw new Error("The vault has no config.json.");
        const next = { ...parseVaultConfig(text), [KEY]: { listed: settings.listed } };
        return JSON.stringify(next, null, 2) + "\n";
      },
      () =>
        this.history.record(vault, [`${VAULT_META_DIR}/${VAULT_CONFIG_FILE}`], by.author, {
          reason:
            by.note?.reason ??
            (settings.listed
              ? "List plugin tools in tools/list"
              : "Hide plugin tools from tools/list"),
        }),
    );
    this.cache.set(vault, { at: this.now(), value: { listed: settings.listed } });
    return { listed: settings.listed };
  }

  private async read(vault: string): Promise<PluginToolSettings> {
    const bytes = await this.vaults.readMetaBytes(vault, VAULT_CONFIG_FILE).catch(() => null);
    if (!bytes) return { listed: false };
    try {
      const raw = parseVaultConfig(new TextDecoder().decode(bytes))[KEY];
      const listed = (raw as { listed?: unknown } | undefined)?.listed;
      return { listed: listed === true };
    } catch {
      return { listed: false };
    }
  }
}
