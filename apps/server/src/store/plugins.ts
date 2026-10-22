import type { PluginManifest } from "@palimvo/plugin-sdk";
import type { Db, Row } from "./db.ts";

export type PluginSource = "library" | "upload";

/** A plugin installed in a vault: which package (by hash) and whether it is switched on. */
export interface VaultPlugin {
  vaultId: string;
  pluginId: string;
  version: string;
  sha256: string;
  manifest: PluginManifest;
  enabled: boolean;
  source: PluginSource;
  installedBy?: string;
  installedAt: number;
}

export interface PluginApproval {
  vaultId: string;
  pluginId: string;
  sha256: string;
  version: string;
  approvedBy?: string;
  approvedAt: number;
  /** What the approving person was shown (the manifest's permissions). */
  permissions: unknown;
}

const toPlugin = (r: Row): VaultPlugin => ({
  vaultId: r.vault_id as string,
  pluginId: r.plugin_id as string,
  version: r.version as string,
  sha256: r.sha256 as string,
  manifest: JSON.parse(r.manifest as string) as PluginManifest,
  enabled: r.enabled === 1,
  source: r.source as PluginSource,
  ...(typeof r.installed_by === "string" ? { installedBy: r.installed_by } : {}),
  installedAt: r.installed_at as number,
});

const toApproval = (r: Row): PluginApproval => ({
  vaultId: r.vault_id as string,
  pluginId: r.plugin_id as string,
  sha256: r.sha256 as string,
  version: r.version as string,
  ...(typeof r.approved_by === "string" ? { approvedBy: r.approved_by } : {}),
  approvedAt: r.approved_at as number,
  permissions: JSON.parse(r.permissions as string) as unknown,
});

/** Installed plugins and the hash approvals that let them run. */
export class PluginsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  list(vaultId: string): VaultPlugin[] {
    return this.db
      .all("select * from vault_plugins where vault_id = ? order by plugin_id", vaultId)
      .map(toPlugin);
  }

  get(vaultId: string, pluginId: string): VaultPlugin | undefined {
    const r = this.db.get(
      "select * from vault_plugins where vault_id = ? and plugin_id = ?",
      vaultId,
      pluginId,
    );
    return r && toPlugin(r);
  }

  /**
   * Records the installed package. Installing over an existing plugin keeps its on/off switch, so
   * an update does not silently turn a plugin on or off.
   */
  put(input: {
    vaultId: string;
    pluginId: string;
    version: string;
    sha256: string;
    manifest: PluginManifest;
    source: PluginSource;
    installedBy?: string;
  }): VaultPlugin {
    this.db.run(
      `insert into vault_plugins (vault_id, plugin_id, version, sha256, manifest, enabled, source, installed_by, installed_at)
       values (?, ?, ?, ?, ?, 0, ?, ?, ?)
       on conflict (vault_id, plugin_id) do update set
         version = excluded.version, sha256 = excluded.sha256, manifest = excluded.manifest, source = excluded.source,
         installed_by = excluded.installed_by, installed_at = excluded.installed_at`,
      input.vaultId,
      input.pluginId,
      input.version,
      input.sha256,
      JSON.stringify(input.manifest),
      input.source,
      input.installedBy ?? null,
      this.now(),
    );
    return this.get(input.vaultId, input.pluginId)!;
  }

  setEnabled(vaultId: string, pluginId: string, enabled: boolean): boolean {
    return (
      this.db.run(
        "update vault_plugins set enabled = ? where vault_id = ? and plugin_id = ?",
        enabled ? 1 : 0,
        vaultId,
        pluginId,
      ).changes > 0
    );
  }

  /** Removes the installation and every approval of that plugin in the vault. */
  remove(vaultId: string, pluginId: string): boolean {
    return this.db.tx(() => {
      this.db.run(
        "delete from plugin_approvals where vault_id = ? and plugin_id = ?",
        vaultId,
        pluginId,
      );
      return (
        this.db.run(
          "delete from vault_plugins where vault_id = ? and plugin_id = ?",
          vaultId,
          pluginId,
        ).changes > 0
      );
    });
  }

  approvals(vaultId: string, pluginId?: string): PluginApproval[] {
    const rows =
      pluginId === undefined
        ? this.db.all(
            "select * from plugin_approvals where vault_id = ? order by plugin_id, approved_at",
            vaultId,
          )
        : this.db.all(
            "select * from plugin_approvals where vault_id = ? and plugin_id = ? order by approved_at",
            vaultId,
            pluginId,
          );
    return rows.map(toApproval);
  }

  isApproved(vaultId: string, pluginId: string, sha256: string): boolean {
    return (
      this.db.get(
        "select 1 as x from plugin_approvals where vault_id = ? and plugin_id = ? and sha256 = ?",
        vaultId,
        pluginId,
        sha256,
      ) !== undefined
    );
  }

  approve(input: Omit<PluginApproval, "approvedAt">): void {
    this.db.run(
      `insert into plugin_approvals (vault_id, plugin_id, sha256, version, approved_by, approved_at, permissions)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (vault_id, plugin_id, sha256) do nothing`,
      input.vaultId,
      input.pluginId,
      input.sha256,
      input.version,
      input.approvedBy ?? null,
      this.now(),
      JSON.stringify(input.permissions),
    );
  }

  /** Withdraws every approval of the plugin; it stops running until a person approves again. */
  revoke(vaultId: string, pluginId: string): number {
    return this.db.run(
      "delete from plugin_approvals where vault_id = ? and plugin_id = ?",
      vaultId,
      pluginId,
    ).changes;
  }
}
