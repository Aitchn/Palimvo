import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError } from "@palimvo/core";
import { resolveLocalized } from "@palimvo/plugin-sdk";
import { accessOf } from "../auth/access.ts";
import { principalOf, requireAccount } from "../auth/principal.ts";
import type { InstalledPlugin, PluginManager } from "../plugins/manager.ts";
import { summarizePermissions } from "../plugins/summary.ts";
import { describeFiles, packageFilesSchema, toPluginFiles } from "../plugins/upload.ts";
import type { LibraryPlugin } from "../store/index.ts";
import type { VaultService } from "../vault/service.ts";
import { requestAuthor, requestNote } from "./author.ts";
import { readJson } from "./util.ts";

const publishBody = z.object({ files: packageFilesSchema });
const installBody = z.union([
  z.object({
    library: z.object({ id: z.string().min(1).max(64), version: z.string().max(64).optional() }),
  }),
  z.object({ files: packageFilesSchema }),
]);
const patchBody = z.object({ enabled: z.boolean() });
const approveBody = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });

const CONTENT_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
};

const libraryJson = (p: LibraryPlugin) => ({
  id: p.id,
  version: p.version,
  name: p.name,
  description: (p.manifest as { description?: unknown }).description ?? null,
  sha256: p.sha256,
  builtin: p.builtin,
  uploadedAt: p.uploadedAt,
  manifest: p.manifest,
});

const installedJson = (p: InstalledPlugin) => ({
  id: p.id,
  version: p.version,
  name: resolveLocalized(p.manifest.name, "en"),
  sha256: p.sha256,
  enabled: p.enabled,
  approved: p.approved,
  state: p.state,
  problems: p.problems,
  source: p.source,
  installedAt: p.installedAt,
  manifest: p.manifest,
});

/**
 * Plugin management, all under `/api`:
 *
 * - `/plugin-library`: the server's library. Anyone signed in may look; `library.publish` adds
 *   and removes versions.
 * - `/vaults/:vault/plugins`: what is installed. `plugin.install` installs, switches and removes;
 *   **only a signed-in person with `plugin.approve`** approves a hash (an AI token never can, and
 *   the person's own token cannot stand in for them).
 */
export function pluginRoutes(plugins: PluginManager, vaults: VaultService): Hono {
  const app = new Hono();

  const vaultOf = async (c: Context, permission?: "plugin.install" | "plugin.approve") => {
    const vault = c.req.param("vault")!;
    const access = accessOf(c);
    access.requireVault("vault.view", vault);
    if (permission) access.requireVault(permission, vault);
    await vaults.assertVault(vault);
    return vault;
  };
  const actorOf = (c: Context) => {
    const p = principalOf(c);
    return {
      ...(p.kind === "account" ? { accountId: p.account.id } : {}),
      author: requestAuthor(c),
      note: requestNote(c),
    };
  };

  // ---- library ----------------------------------------------------------------------------

  app.get("/api/plugin-library", (c) => {
    requireAccount(c);
    return c.json({ plugins: plugins.listLibrary().map(libraryJson) });
  });

  app.post("/api/plugin-library", async (c) => {
    const access = accessOf(c);
    access.requireServer("library.publish");
    const body = await readJson(c, publishBody);
    const p = principalOf(c);
    const entry = await plugins.publish(toPluginFiles(body.files), {
      ...(p.kind === "account" ? { accountId: p.account.id, label: p.account.username } : {}),
    });
    return c.json(libraryJson(entry), 201);
  });

  const removeFromLibrary = async (c: Context) => {
    accessOf(c).requireServer("library.publish");
    const removed = await plugins.removeFromLibrary(c.req.param("id")!, c.req.param("version"));
    if (removed === 0) throw new AppError("not_found");
    return c.json({ removed });
  };
  app.delete("/api/plugin-library/:id", removeFromLibrary);
  app.delete("/api/plugin-library/:id/:version", removeFromLibrary);

  // ---- vault ----------------------------------------------------------------------------------

  app.get("/api/vaults/:vault/plugins", async (c) => {
    const vault = await vaultOf(c);
    return c.json({ plugins: plugins.list(vault).map(installedJson) });
  });

  app.post("/api/vaults/:vault/plugins", async (c) => {
    const vault = await vaultOf(c, "plugin.install");
    const body = await readJson(c, installBody);
    const actor = actorOf(c);
    const result =
      "library" in body
        ? await plugins.installFromLibrary(vault, body.library.id, body.library.version, actor)
        : await plugins.install(vault, toPluginFiles(body.files), "upload", actor);
    return c.json(
      {
        ...installedJson(result.plugin),
        warnings: result.warnings,
        summary: summarizePermissions(result.plugin.manifest),
      },
      201,
    );
  });

  app.get("/api/vaults/:vault/plugins/:id", async (c) => {
    const vault = await vaultOf(c);
    const id = c.req.param("id")!;
    const plugin = plugins.get(vault, id);
    if (!plugin) throw new AppError("not_found");
    return c.json({
      ...installedJson(plugin),
      summary: summarizePermissions(plugin.manifest),
      approvals: plugins.approvals(vault, id).map((a) => ({
        sha256: a.sha256,
        version: a.version,
        approvedBy: a.approvedBy ?? null,
        approvedAt: a.approvedAt,
      })),
    });
  });

  app.patch("/api/vaults/:vault/plugins/:id", async (c) => {
    const vault = await vaultOf(c, "plugin.install");
    const body = await readJson(c, patchBody);
    const plugin = plugins.setEnabled(vault, c.req.param("id")!, body.enabled, actorOf(c));
    return c.json(installedJson(plugin));
  });

  app.delete("/api/vaults/:vault/plugins/:id", async (c) => {
    const vault = await vaultOf(c, "plugin.install");
    await plugins.uninstall(vault, c.req.param("id")!, actorOf(c));
    return c.json({ ok: true });
  });

  app.post("/api/vaults/:vault/plugins/:id/approve", async (c) => {
    const vault = await vaultOf(c, "plugin.approve");
    // Approving is a person's call: a session, never a token of theirs.
    const { account } = requireAccount(c);
    const body = await readJson(c, approveBody);
    const plugin = await plugins.approve(vault, c.req.param("id")!, body.sha256, {
      accountId: account.id,
    });
    return c.json(installedJson(plugin));
  });

  app.post("/api/vaults/:vault/plugins/:id/revoke", async (c) => {
    const vault = await vaultOf(c, "plugin.approve");
    requireAccount(c);
    return c.json(installedJson(plugins.revoke(vault, c.req.param("id")!, actorOf(c))));
  });

  /** The plugin's files with their text, for the person deciding whether to approve. */
  app.get("/api/vaults/:vault/plugins/:id/package", async (c) => {
    const vault = await vaultOf(c);
    const access = accessOf(c);
    if (!access.can("plugin.install", { kind: "vault", vaultId: vault }))
      access.requireVault("plugin.approve", vault);
    return c.json({ files: describeFiles(await plugins.readFiles(vault, c.req.param("id")!)) });
  });

  /** One file of a plugin that is running (the web host loads `main.js` from here). */
  app.get("/api/vaults/:vault/plugins/:id/files/:file{.+}", async (c) => {
    const vault = await vaultOf(c);
    const { files } = await plugins.load(vault, c.req.param("id")!);
    const name = c.req.param("file");
    const file = files.find((f) => f.path === name);
    if (!file) throw new AppError("not_found");
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    return c.body(file.bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, no-cache",
    });
  });

  // ---- runtime (what the web host loads) -------------------------------------------------

  /** The plugins the web host should start: switched on, approved at their current hash, runnable. */
  app.get("/api/vaults/:vault/plugin-runtime", async (c) => {
    const vault = await vaultOf(c);
    c.header("cache-control", "private, no-store");
    const running = (await plugins.list(vault)).filter((p) => p.state === "running");
    return c.json({
      plugins: running.map((p) => ({
        id: p.id,
        version: p.version,
        hash: p.sha256,
        manifest: p.manifest,
      })),
    });
  });

  /**
   * The text the host needs to start one running plugin: `main`, the locale files and the theme
   * stylesheet. The files are re-hashed first, so edited files never reach the browser.
   */
  app.get("/api/vaults/:vault/plugin-runtime/:id", async (c) => {
    const vault = await vaultOf(c);
    c.header("cache-control", "private, no-store");
    const { plugin, files } = await plugins.load(vault, c.req.param("id")!);
    const { manifest } = plugin;
    const wanted = [
      manifest.main,
      ...Object.values(manifest.locales ?? {}),
      ...(manifest.contributes.theme ? [manifest.contributes.theme.css] : []),
    ];
    const decoder = new TextDecoder();
    const text: Record<string, string> = {};
    for (const path of wanted) {
      const file = files.find((f) => f.path === path);
      if (file) text[path] = decoder.decode(file.bytes);
    }
    return c.json({ id: plugin.id, hash: plugin.sha256, files: text });
  });

  return app;
}
