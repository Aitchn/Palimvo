import {
  pathAllowed,
  resolveLocalized,
  validateManifest,
  type ManifestIssue,
  type PluginManifest,
} from "@palimvo/plugin-sdk";
import { folderScope, dirname } from "@palimvo/core";
import type { RequestAccess } from "../auth/access.ts";

/** What a person needs to see before approving a plugin; the approval screen draws it. */
export interface PermissionSummary {
  /** Folders it may read; `["**"]` is the whole vault. */
  read: string[];
  write: string[];
  /** `false`: no network. Otherwise the hosts. */
  network: false | string[];
  readsWholeVault: boolean;
  writesWholeVault: boolean;
  /** True when it may reach any host (`*`). */
  anyNetwork: boolean;
  /** MCP tools it adds (`<id>.<tool>`) and whether each changes the vault. */
  tools: { name: string; readOnly: boolean }[];
  /** What it adds to the interface, by kind, e.g. `{ views: 1, codeBlocks: 1 }`. */
  contributes: Record<string, number>;
  dependencies: Record<string, string>;
  /** Powerful requests the validator flagged. */
  warnings: ManifestIssue[];
}

const WHOLE_VAULT = new Set(["*", "**", "**/*"]);

export function summarizePermissions(manifest: PluginManifest): PermissionSummary {
  const { permissions: p, contributes: c } = manifest;
  const counted: Record<string, number> = {};
  for (const [kind, value] of Object.entries(c)) {
    const n = Array.isArray(value) ? value.length : value ? 1 : 0;
    if (n > 0 && kind !== "tools") counted[kind] = n;
  }
  const validated = validateManifest(manifest);
  return {
    read: p.read,
    write: p.write,
    network: p.network,
    readsWholeVault: p.read.some((g) => WHOLE_VAULT.has(g)),
    writesWholeVault: p.write.some((g) => WHOLE_VAULT.has(g)),
    anyNetwork: p.network !== false && p.network.includes("*"),
    tools: c.tools.map((t) => ({
      name: `${manifest.id}.${t.name}`,
      readOnly: t.readOnly === true,
    })),
    contributes: counted,
    dependencies: manifest.dependencies,
    warnings: validated.ok ? validated.warnings : [],
  };
}

export const displayName = (manifest: PluginManifest, locale = "en"): string =>
  resolveLocalized(manifest.name, locale);

/**
 * Whether a running plugin may touch `path`: the manifest must declare a folder covering it
 * **and** the person it acts for must hold the permission there. The plugin never has more than
 * the person using it, whatever the manifest asks for.
 */
export function pluginMayAccess(
  manifest: PluginManifest,
  mode: "read" | "write",
  vault: string,
  path: string,
  access: RequestAccess,
): boolean {
  if (!pathAllowed(manifest.permissions[mode], path)) return false;
  return access.can(
    mode === "read" ? "note.read" : "note.write",
    folderScope(vault, dirname(path)),
  );
}
