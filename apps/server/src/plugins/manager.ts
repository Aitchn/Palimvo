import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AppError, VAULT_META_DIR, type Author } from "@palimvo/core";
import {
  computePluginHash,
  compareVersions,
  type PluginFile,
  type PluginManifest,
} from "@palimvo/plugin-sdk";
import type { ChangeNote, ChangeRecorder } from "../history/history.ts";
import type { Logger } from "../log.ts";
import type {
  LibraryPlugin,
  PluginApproval,
  PluginSource,
  Store,
  VaultPlugin,
} from "../store/index.ts";
import { atomicWrite } from "../vault/atomic.ts";
import type { VaultService } from "../vault/service.ts";
import type { PluginCatalog } from "../mcp/dispatch.ts";
import { resolveDependencies, type PluginProblem } from "./deps.ts";
import { inspectPackage, type InspectedPackage } from "./package.ts";
import { summarizePermissions, type PermissionSummary } from "./summary.ts";

/** Where a vault keeps installed plugins, inside `.palimvo/`. */
export const PLUGINS_DIR = "plugins";
/** A folder of the official plugins directory that holds developer examples, not plugins to ship. */
const EXAMPLES_DIR = "examples";

/** Why an installed plugin is or is not running. */
export type PluginState =
  /** Switched on, approved, and its dependencies run: it runs. */
  | "running"
  | "disabled"
  /** The installed package (this exact hash) has not been approved by a person. */
  | "needs_approval"
  /** Approved and on, but a dependency cannot run. */
  | "blocked";

export interface InstalledPlugin {
  id: string;
  version: string;
  sha256: string;
  enabled: boolean;
  approved: boolean;
  state: PluginState;
  problems: PluginProblem[];
  source: PluginSource;
  installedBy?: string;
  installedAt: number;
  manifest: PluginManifest;
}

export interface Actor {
  /** The signed-in account behind the call. */
  accountId?: string;
  /** Who the history credits for the installed files. */
  author: Author;
  note?: ChangeNote;
}

export interface PluginManagerDeps {
  store: Store;
  vaults: Pick<
    VaultService,
    "assertVault" | "readMetaBytes" | "writeMetaBytes" | "listMetaFiles" | "removeMeta"
  >;
  history: ChangeRecorder;
  /** `<data>/library/plugins`: the server's plugin library files. */
  libraryDir: string;
  /** The running Palimvo version; a plugin needing a newer one is refused. */
  palimvoVersion: string;
  logger: Logger;
}

const toActorId = (a: Actor) => (a.accountId ? { installedBy: a.accountId } : {});

/**
 * Installs, approves and switches plugins, and keeps the server's plugin library.
 *
 * - A plugin is a package of files with a content hash (`computePluginHash`). It is installed
 *   into `<vault>/.palimvo/plugins/<id>/`, so it travels with the vault's files and history.
 * - Running needs three things: it is switched on, a **person** approved this exact hash in this
 *   vault (kept in the server database, not in the vault), and its dependencies run. Changing one
 *   byte gives a new hash, which is not approved.
 * - `load` re-reads the files and re-hashes them every time the runtime asks, so files edited on
 *   disk after approval never run.
 */
export class PluginManager implements PluginCatalog {
  constructor(private readonly deps: PluginManagerDeps) {}

  private get store(): Store {
    return this.deps.store;
  }

  // ---- library ----------------------------------------------------------------------------

  /** Every version of every library plugin, newest upload first. */
  listLibrary(): LibraryPlugin[] {
    return this.store.library.list();
  }

  /** Checks and stores a package in the library. Versions are immutable. */
  async publish(
    files: readonly PluginFile[],
    by: { accountId?: string; label?: string; builtin?: boolean },
  ): Promise<LibraryPlugin> {
    const pkg = await inspectPackage(files, this.compatibility());
    const { manifest } = pkg;
    if (this.store.library.get(manifest.id, manifest.version)) {
      throw new AppError("already_exists", 409, undefined, {
        message: `${manifest.id}@${manifest.version} is already in the library. Publish a new version number instead.`,
      });
    }
    const dir = this.libraryPath(manifest.id, manifest.version);
    await rm(dir, { recursive: true, force: true });
    await this.writeFiles(dir, pkg.files);
    const name = typeof manifest.name === "string" ? manifest.name : manifest.name.en;
    const entry = this.store.library.add({
      id: manifest.id,
      version: manifest.version,
      name,
      manifest,
      sha256: pkg.sha256,
      builtin: by.builtin === true,
      ...(by.accountId ? { uploadedBy: by.accountId } : {}),
    });
    this.store.audit.append({
      actorType: by.accountId ? "account" : "system",
      ...(by.accountId ? { actorId: by.accountId } : {}),
      ...(by.label ? { actorLabel: by.label } : {}),
      action: "plugin.library.publish",
      targetType: "plugin",
      targetId: `${manifest.id}@${manifest.version}`,
      detail: { sha256: pkg.sha256, builtin: by.builtin === true },
    });
    return entry;
  }

  /** Removes a library version (or every version). Installed copies in vaults are not touched. */
  async removeFromLibrary(id: string, version?: string): Promise<number> {
    const versions = this.store.library
      .versionsOf(id)
      .filter((p) => version === undefined || p.version === version);
    if (versions.some((p) => p.builtin))
      throw new AppError("forbidden", undefined, undefined, {
        message: "Plugins that ship with Palimvo cannot be removed from the library.",
      });
    for (const p of versions) {
      await rm(this.libraryPath(p.id, p.version), { recursive: true, force: true });
      this.store.library.remove(p.id, p.version);
    }
    return versions.length;
  }

  /** The package of a library version, re-hashed against the recorded hash. */
  async readLibraryPackage(
    id: string,
    version?: string,
  ): Promise<{
    entry: LibraryPlugin;
    files: PluginFile[];
  }> {
    const versions = this.store.library.versionsOf(id);
    const entry =
      version === undefined
        ? versions.toSorted((a, b) => compareVersions(b.version, a.version))[0]
        : versions.find((p) => p.version === version);
    if (!entry)
      throw new AppError("not_found", undefined, undefined, {
        message: `The library has no plugin "${id}"${version ? ` ${version}` : ""}.`,
      });
    const files = await readTree(this.libraryPath(entry.id, entry.version));
    const actual = files.length > 0 ? await computePluginHash(files).catch(() => "") : "";
    if (actual !== entry.sha256)
      throw new AppError("internal", 500, undefined, {
        message: `The library copy of ${id}@${entry.version} does not match its recorded hash.`,
      });
    return { entry, files };
  }

  private libraryPath(id: string, version: string): string {
    return path.join(this.deps.libraryDir, id, version);
  }

  /**
   * What `minPalimvo` is checked against. A build that still reports 0.0.0 (a checkout before the
   * first release) accepts every plugin, otherwise the official ones, which ask for the version
   * they ship with, could never be installed from a development tree.
   */
  private compatibility(): { palimvoVersion?: string } {
    const version = this.deps.palimvoVersion;
    return version === "0.0.0" ? {} : { palimvoVersion: version };
  }

  /** Adds the official plugins found in `dir` to the library. A folder that fails the checks is skipped with a warning. */
  async seedBuiltins(dir: string): Promise<string[]> {
    const added: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries
      .filter((x) => x.isDirectory() && x.name !== EXAMPLES_DIR)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const files = await readTree(path.join(dir, e.name));
        const pkg = await inspectPackage(files, this.compatibility());
        const existing = this.store.library.get(pkg.manifest.id, pkg.manifest.version);
        if (existing) {
          if (existing.sha256 !== pkg.sha256)
            this.deps.logger.warn("official plugin changed without a new version", {
              plugin: pkg.manifest.id,
              version: pkg.manifest.version,
            });
          continue;
        }
        await this.publish(files, { builtin: true, label: "palimvo" });
        added.push(`${pkg.manifest.id}@${pkg.manifest.version}`);
      } catch (err) {
        this.deps.logger.warn("official plugin skipped", {
          folder: e.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return added;
  }

  // ---- vault installation ---------------------------------------------------------------------

  /** Installs a package into a vault (off until a person approves and switches it on). */
  async install(
    vault: string,
    files: readonly PluginFile[],
    source: PluginSource,
    actor: Actor,
  ): Promise<{ plugin: InstalledPlugin; warnings: InspectedPackage["warnings"] }> {
    await this.deps.vaults.assertVault(vault);
    const pkg = await inspectPackage(files, this.compatibility());
    const { manifest } = pkg;
    const folder = `${PLUGINS_DIR}/${manifest.id}`;
    const previous = await this.deps.vaults.listMetaFiles(vault, folder);
    await this.deps.vaults.removeMeta(vault, folder);
    for (const f of pkg.files)
      await this.deps.vaults.writeMetaBytes(vault, `${folder}/${f.path}`, f.bytes);
    this.store.plugins.put({
      vaultId: vault,
      pluginId: manifest.id,
      version: manifest.version,
      sha256: pkg.sha256,
      manifest,
      source,
      ...toActorId(actor),
    });
    const touched = new Set([...previous, ...pkg.files.map((f) => f.path)]);
    this.deps.history.record(
      vault,
      [...touched].map((p) => `${VAULT_META_DIR}/${folder}/${p}`),
      actor.author,
      actor.note ?? { reason: `Install plugin ${manifest.id} ${manifest.version}` },
    );
    this.audit(vault, actor, "plugin.install", manifest.id, {
      version: manifest.version,
      sha256: pkg.sha256,
      source,
    });
    return { plugin: this.require(vault, manifest.id), warnings: pkg.warnings };
  }

  /** Installs a library plugin (the newest version unless one is named). */
  async installFromLibrary(vault: string, id: string, version: string | undefined, actor: Actor) {
    const { files } = await this.readLibraryPackage(id, version);
    return this.install(vault, files, "library", actor);
  }

  async uninstall(vault: string, id: string, actor: Actor): Promise<void> {
    const current = this.requireRow(vault, id);
    const folder = `${PLUGINS_DIR}/${id}`;
    const files = await this.deps.vaults.listMetaFiles(vault, folder);
    await this.deps.vaults.removeMeta(vault, folder);
    this.store.plugins.remove(vault, id);
    this.deps.history.record(
      vault,
      files.map((p) => `${VAULT_META_DIR}/${folder}/${p}`),
      actor.author,
      actor.note ?? { reason: `Uninstall plugin ${id}` },
    );
    this.audit(vault, actor, "plugin.uninstall", id, { version: current.version });
  }

  setEnabled(vault: string, id: string, enabled: boolean, actor: Actor): InstalledPlugin {
    this.requireRow(vault, id);
    this.store.plugins.setEnabled(vault, id, enabled);
    this.audit(vault, actor, enabled ? "plugin.enable" : "plugin.disable", id);
    return this.require(vault, id);
  }

  // ---- approval ---------------------------------------------------------------------------------

  /**
   * A person approves the installed package. `sha256` is the hash they were shown; if the
   * installed package is not that one any more (it was replaced meanwhile) nothing is approved.
   * The files on disk are re-hashed as well, so a package edited in place cannot be approved
   * under the old hash.
   */
  async approve(
    vault: string,
    id: string,
    sha256: string,
    approver: { accountId: string },
  ): Promise<InstalledPlugin> {
    const row = this.requireRow(vault, id);
    if (row.sha256 !== sha256)
      throw new AppError("proposal_changed", undefined, undefined, {
        message: "The installed plugin changed since you looked at it. Reload and review it again.",
      });
    const files = await this.readInstalled(vault, id);
    if ((await computePluginHash(files).catch(() => "")) !== row.sha256)
      throw new AppError("plugin_invalid", undefined, undefined, {
        message: "The plugin's files do not match the installed package. Install it again.",
      });
    this.store.plugins.approve({
      vaultId: vault,
      pluginId: id,
      sha256,
      version: row.version,
      approvedBy: approver.accountId,
      permissions: row.manifest.permissions,
    });
    this.store.audit.append({
      actorType: "account",
      actorId: approver.accountId,
      action: "plugin.approve",
      targetType: "plugin",
      targetId: id,
      vaultId: vault,
      detail: { version: row.version, sha256 },
    });
    return this.require(vault, id);
  }

  /** Withdraws every approval; the plugin stops until a person approves it again. */
  revoke(vault: string, id: string, actor: Actor): InstalledPlugin {
    this.requireRow(vault, id);
    this.store.plugins.revoke(vault, id);
    this.audit(vault, actor, "plugin.revoke", id);
    return this.require(vault, id);
  }

  approvals(vault: string, id: string): PluginApproval[] {
    return this.store.plugins.approvals(vault, id);
  }

  // ---- state ------------------------------------------------------------------------------------

  /** Every plugin installed in the vault with whether it runs. */
  list(vault: string): InstalledPlugin[] {
    const rows = this.store.plugins.list(vault);
    const approved = new Set(
      this.store.plugins.approvals(vault).map((a) => `${a.pluginId}\0${a.sha256}`),
    );
    const flags = rows.map((r) => ({
      row: r,
      approved: approved.has(`${r.pluginId}\0${r.sha256}`),
    }));
    const problems = resolveDependencies(
      flags.map(({ row, approved: ok }) => ({ manifest: row.manifest, wanted: row.enabled && ok })),
    );
    return flags.map(({ row, approved: ok }) => {
      const list = problems.get(row.pluginId) ?? [];
      const state: PluginState = !row.enabled
        ? "disabled"
        : !ok
          ? "needs_approval"
          : list.length > 0
            ? "blocked"
            : "running";
      return toInstalled(row, ok, state, list);
    });
  }

  get(vault: string, id: string): InstalledPlugin | undefined {
    return this.list(vault).find((p) => p.id === id);
  }

  private require(vault: string, id: string): InstalledPlugin {
    const found = this.get(vault, id);
    if (!found) throw notInstalled(id);
    return found;
  }

  private requireRow(vault: string, id: string): VaultPlugin {
    const row = this.store.plugins.get(vault, id);
    if (!row) throw notInstalled(id);
    return row;
  }

  /** The plugins that run in the vault: switched on, approved, dependencies met. */
  enabled(vault: string): readonly { id: string; version: string }[] {
    return this.list(vault)
      .filter((p) => p.state === "running")
      .map((p) => ({ id: p.id, version: p.version }));
  }

  /** What the approval screen shows. */
  summary(vault: string, id: string): PermissionSummary {
    return summarizePermissions(this.require(vault, id).manifest);
  }

  // ---- files ------------------------------------------------------------------------------------

  /**
   * The files of a plugin that is allowed to run, after re-hashing them: this is what the web
   * host and the server sandbox load. Throws `plugin_not_approved` when the plugin is off, not
   * approved, blocked, or its files no longer match the approved hash.
   */
  async load(vault: string, id: string): Promise<{ plugin: InstalledPlugin; files: PluginFile[] }> {
    const plugin = this.require(vault, id);
    if (plugin.state !== "running") throw notApproved(plugin);
    const files = await this.readInstalled(vault, id);
    if ((await computePluginHash(files).catch(() => "")) !== plugin.sha256) {
      this.deps.logger.warn("plugin files do not match the approved hash", { vault, plugin: id });
      throw new AppError("plugin_not_approved", undefined, undefined, {
        message: `The files of "${id}" changed after they were approved, so it will not run. Install it again and approve it.`,
      });
    }
    return { plugin, files };
  }

  /** Files of an installed plugin for a person who may install plugins (review, not running). */
  async readFiles(vault: string, id: string): Promise<PluginFile[]> {
    this.requireRow(vault, id);
    return this.readInstalled(vault, id);
  }

  private async readInstalled(vault: string, id: string): Promise<PluginFile[]> {
    const folder = `${PLUGINS_DIR}/${id}`;
    const names = await this.deps.vaults.listMetaFiles(vault, folder);
    const files: PluginFile[] = [];
    for (const name of names) {
      const bytes = await this.deps.vaults.readMetaBytes(vault, `${folder}/${name}`);
      if (bytes) files.push({ path: name, bytes });
    }
    return files;
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private async writeFiles(dir: string, files: readonly PluginFile[]): Promise<void> {
    for (const f of files) {
      const abs = path.join(dir, ...f.path.split("/"));
      await mkdir(path.dirname(abs), { recursive: true });
      await atomicWrite(abs, f.bytes);
    }
  }

  private audit(vault: string, actor: Actor, action: string, id: string, detail?: unknown): void {
    this.store.audit.append({
      actorType: actor.accountId ? "account" : "system",
      ...(actor.accountId ? { actorId: actor.accountId } : {}),
      actorLabel: actor.author.name,
      action,
      targetType: "plugin",
      targetId: id,
      vaultId: vault,
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

function toInstalled(
  row: VaultPlugin,
  approved: boolean,
  state: PluginState,
  problems: PluginProblem[],
): InstalledPlugin {
  return {
    id: row.pluginId,
    version: row.version,
    sha256: row.sha256,
    enabled: row.enabled,
    approved,
    state,
    problems,
    source: row.source,
    ...(row.installedBy ? { installedBy: row.installedBy } : {}),
    installedAt: row.installedAt,
    manifest: row.manifest,
  };
}

const notInstalled = (id: string) =>
  new AppError("not_found", undefined, undefined, {
    message: `The plugin "${id}" is not installed in this vault.`,
  });

function notApproved(plugin: InstalledPlugin): AppError {
  const why =
    plugin.state === "disabled"
      ? "it is switched off"
      : plugin.state === "needs_approval"
        ? "this version has not been approved by a person"
        : (plugin.problems[0]?.message ?? "a dependency cannot run");
  return new AppError(
    "plugin_not_approved",
    undefined,
    { state: plugin.state },
    {
      message: `"${plugin.id}" cannot run: ${why}.`,
    },
  );
}

/** Every file below `dir` as package files with `/` paths; empty when the folder does not exist. */
async function readTree(dir: string, rel = ""): Promise<PluginFile[]> {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  const out: PluginFile[] = [];
  for (const e of entries) {
    const child = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await readTree(dir, child)));
    else if (e.isFile())
      out.push({ path: child, bytes: new Uint8Array(await readFile(path.join(dir, child))) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
