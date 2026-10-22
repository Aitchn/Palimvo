import { z } from "zod";
import { AppError } from "@palimvo/core";
import { resolveLocalized } from "@palimvo/plugin-sdk";
import { principalOf } from "../../auth/principal.ts";
import type { InstalledPlugin, PluginManager } from "../../plugins/manager.ts";
import { summarizePermissions } from "../../plugins/summary.ts";
import { describeFiles, packageFilesSchema, toPluginFiles } from "../../plugins/upload.ts";
import { mcpTool, type Ctx } from "./shared.ts";

function managerOf(ctx: Ctx): PluginManager {
  const manager = ctx.deps.pluginManager;
  if (!manager) throw new AppError("not_implemented");
  return manager;
}

const actorOf = (ctx: Ctx) => {
  const p = principalOf(ctx.request);
  return {
    ...(p.kind === "token" ? { accountId: p.account.id } : {}),
    author: ctx.author,
    note: ctx.note,
  };
};

const NEEDS_APPROVAL =
  "A person must approve it in the web app (Settings > Plugins) before it runs; an AI cannot approve plugins.";

const brief = (p: InstalledPlugin) => ({
  id: p.id,
  version: p.version,
  name: resolveLocalized(p.manifest.name, "en"),
  state: p.state,
  enabled: p.enabled,
  approved: p.approved,
  sha256: p.sha256,
  ...(p.problems.length > 0 ? { problems: p.problems.map((x) => x.message) } : {}),
});

const FILES_HELP =
  "files: every file of the package as {path, text}; `manifest.json` is required and every file it names (main, server, theme css, locales) must be included. See the plugin guide for the manifest.";

export const listPlugins = mcpTool({
  name: "list_plugins",
  tier: "advanced",
  scope: "vault",
  permission: "vault.view",
  input: z.object({}),
  description:
    "The plugins installed in a vault and whether each runs (state: running, disabled, needs_approval or blocked). Example: {vault:'team-notes'}.",
  handler: (_args, ctx) => ({ plugins: managerOf(ctx).list(ctx.vault).map(brief) }),
});

export const listLibraryPlugins = mcpTool({
  name: "list_library_plugins",
  tier: "advanced",
  scope: "vault",
  permission: "vault.view",
  input: z.object({}),
  description:
    "The server's plugin library: plugins an administrator published, every version, with what each asks to do. Install one with install_library_plugin. Example: {vault:'team-notes'}.",
  handler: (_args, ctx) => ({
    plugins: managerOf(ctx)
      .listLibrary()
      .map((p) => ({
        id: p.id,
        version: p.version,
        name: p.name,
        builtin: p.builtin,
        sha256: p.sha256,
        permissions: summarizePermissions(p.manifest as Parameters<typeof summarizePermissions>[0]),
      })),
  }),
});

export const readPlugin = mcpTool({
  name: "read_plugin",
  tier: "advanced",
  scope: "vault",
  permission: "vault.view",
  input: z.object({
    id: z.string().min(1).describe("The plugin id."),
    path: z.string().optional().describe("One file to read; leave out to list the files."),
  }),
  description:
    "Read an installed plugin: its manifest, what it asks to do and its files, or one file's text. Example: {vault:'team-notes', id:'kanban', path:'manifest.json'}.",
  handler: async (args, ctx) => {
    const manager = managerOf(ctx);
    const plugin = manager.get(ctx.vault, args.id);
    if (!plugin) throw new AppError("not_found");
    const files = describeFiles(await manager.readFiles(ctx.vault, args.id));
    if (args.path !== undefined) {
      const file = files.find((f) => f.path === args.path);
      if (!file) throw new AppError("not_found");
      return { path: file.path, size: file.size, text: file.text ?? null };
    }
    return {
      ...brief(plugin),
      permissions: summarizePermissions(plugin.manifest),
      files: files.map(({ path, size }) => ({ path, size })),
    };
  },
});

export const installPlugin = mcpTool({
  name: "install_plugin",
  tier: "advanced",
  scope: "vault",
  permission: "plugin.install",
  adminGrant: true,
  endpoints: ["all"],
  writes: true,
  input: z.object({ files: packageFilesSchema.describe(FILES_HELP) }),
  description: `Install a plugin you wrote into a vault. It starts switched off. ${NEEDS_APPROVAL} Only for connections the person allowed to administer. Example: {vault:'team-notes', files:[{path:'manifest.json', text:'{...}'}, {path:'main.js', text:'...'}], reason:'Board for tasks'}.`,
  handler: async (args, ctx) => {
    const { plugin, warnings } = await managerOf(ctx).install(
      ctx.vault,
      toPluginFiles(args.files),
      "upload",
      actorOf(ctx),
    );
    return { ...brief(plugin), warnings, next: NEEDS_APPROVAL };
  },
});

export const installLibraryPlugin = mcpTool({
  name: "install_library_plugin",
  tier: "advanced",
  scope: "vault",
  permission: "plugin.install",
  adminGrant: true,
  endpoints: ["all"],
  writes: true,
  input: z.object({
    id: z.string().min(1).describe("The plugin id (see list_library_plugins)."),
    version: z.string().optional().describe("A version; the newest when left out."),
  }),
  description: `Install a plugin from the server's library into a vault. It starts switched off. ${NEEDS_APPROVAL} Only for connections the person allowed to administer. Example: {vault:'team-notes', id:'kanban', reason:'Task board'}.`,
  handler: async (args, ctx) => {
    const { plugin } = await managerOf(ctx).installFromLibrary(
      ctx.vault,
      args.id,
      args.version,
      actorOf(ctx),
    );
    return { ...brief(plugin), next: NEEDS_APPROVAL };
  },
});

export const setPluginEnabled = mcpTool({
  name: "set_plugin_enabled",
  tier: "advanced",
  scope: "vault",
  permission: "plugin.install",
  adminGrant: true,
  endpoints: ["all"],
  writes: true,
  input: z.object({ id: z.string().min(1), enabled: z.boolean() }),
  description:
    "Switch an installed plugin on or off. Switching on does not skip approval: it runs only while its exact files are approved. Only for connections the person allowed to administer. Example: {vault:'team-notes', id:'kanban', enabled:true, reason:'Start using the board'}.",
  handler: (args, ctx) =>
    brief(managerOf(ctx).setEnabled(ctx.vault, args.id, args.enabled, actorOf(ctx))),
});

export const uninstallPlugin = mcpTool({
  name: "uninstall_plugin",
  tier: "advanced",
  scope: "vault",
  permission: "plugin.install",
  adminGrant: true,
  endpoints: ["all"],
  writes: true,
  destructive: true,
  input: z.object({ id: z.string().min(1) }),
  description:
    "Remove an installed plugin and its approvals from a vault. Its files stay in the version history. Only for connections the person allowed to administer. Example: {vault:'team-notes', id:'kanban', reason:'Not used any more'}.",
  handler: async (args, ctx) => {
    await managerOf(ctx).uninstall(ctx.vault, args.id, actorOf(ctx));
    return { removed: args.id };
  },
});

export const publishLibraryPlugin = mcpTool({
  name: "publish_library_plugin",
  tier: "advanced",
  scope: "server",
  permission: "library.publish",
  adminGrant: true,
  endpoints: ["all"],
  writes: true,
  input: z.object({ files: packageFilesSchema.describe(FILES_HELP) }),
  description:
    "Publish a plugin package (a new version) to the server's plugin library so owners can install it. A version can never be replaced. Only for connections the person allowed to administer. Example: {files:[{path:'manifest.json', text:'{...}'}, {path:'main.js', text:'...'}], reason:'First release'}.",
  handler: async (args, ctx) => {
    const p = principalOf(ctx.request);
    const entry = await managerOf(ctx).publish(toPluginFiles(args.files), {
      ...(p.kind === "token" ? { accountId: p.account.id } : {}),
      label: ctx.author.name,
    });
    return { id: entry.id, version: entry.version, sha256: entry.sha256 };
  },
});

export const removeLibraryPlugin = mcpTool({
  name: "remove_library_plugin",
  tier: "advanced",
  scope: "server",
  permission: "library.publish",
  adminGrant: true,
  endpoints: ["all"],
  writes: true,
  destructive: true,
  input: z.object({
    id: z.string().min(1),
    version: z.string().optional().describe("One version; every version when left out."),
  }),
  description:
    "Remove a plugin (one version or all) from the server's library. Copies already installed in vaults keep working. Plugins that ship with Palimvo cannot be removed. Only for connections the person allowed to administer. Example: {id:'my-board', version:'1.0.0', reason:'Replaced by 1.1.0'}.",
  handler: async (args, ctx) => {
    const removed = await managerOf(ctx).removeFromLibrary(args.id, args.version);
    if (removed === 0) throw new AppError("not_found");
    return { removed };
  },
});
