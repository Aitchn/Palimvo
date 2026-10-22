import { Hono, type Context } from "hono";
import { AppError, normalizeVaultPath, type PermissionName } from "@palimvo/core";
import { z } from "zod";
import { accessOf } from "../auth/access.ts";
import type { BackupService } from "../history/backup.ts";
import type { VaultHistory } from "../history/history.ts";
import type { VaultService } from "../vault/service.ts";
import { requestAuthor, requestNote } from "./author.ts";
import { readJson } from "./util.ts";

export interface HistoryRouteDeps {
  vaults: VaultService;
  history: VaultHistory;
  backup: BackupService;
}

const restoreBody = z.object({
  path: z.string(),
  commit: z.string(),
  /** The file's path in that commit, when it has been renamed since. */
  from: z.string().optional(),
});
const checkpointBody = z.object({ message: z.string(), tag: z.string().optional() });
const backupBody = z.object({
  remote: z.string().nullable(),
  intervalMinutes: z.number().optional(),
});

/** Version history, restore, checkpoints and off-site backup: `/api/vaults/:vault/…`. */
export function historyRoutes({ vaults, history, backup }: HistoryRouteDeps): Hono {
  const app = new Hono();

  /**
   * Checks the caller's permission first, so a vault the person cannot see answers like a missing
   * one, then fails with `vault_not_found` before git is asked about a vault that does not exist.
   */
  const known = async (c: Context, name: PermissionName) => {
    const vault = c.req.param("vault")!;
    accessOf(c).requireVault(name, vault);
    await vaults.assertVault(vault);
    return vault;
  };

  app.get("/api/vaults/:vault/history", async (c) => {
    const vault = await known(c, "history.view");
    const limit = Number(c.req.query("limit") ?? 50);
    // Changes still waiting for their commit timer belong in the list people are looking at.
    // If git is busy the older list is still right, and the commit retries on its own timer.
    await history.commit(vault).catch(() => undefined);
    const commits = await history.list(vault, {
      ...(c.req.query("path") ? { path: normalizePath(c.req.query("path")!) } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({ commits });
  });

  // Registered before `:commit/diff`, so "compare" is never taken for a commit id.
  app.get("/api/vaults/:vault/history/compare", async (c) => {
    const vault = await known(c, "history.view");
    const from = c.req.query("from") ?? "";
    const to = c.req.query("to") ?? "";
    const file = c.req.query("path");
    return c.json({
      diff: await history.compare(vault, from, to, file ? normalizePath(file) : undefined),
    });
  });

  app.get("/api/vaults/:vault/history/:commit/diff", async (c) => {
    const vault = await known(c, "history.view");
    const file = c.req.query("path");
    return c.json({
      diff: await history.diff(
        vault,
        c.req.param("commit"),
        file ? normalizePath(file) : undefined,
      ),
    });
  });

  app.get("/api/vaults/:vault/history/:commit/file", async (c) => {
    const vault = await known(c, "history.view");
    const file = normalizePath(c.req.query("path") ?? "");
    const bytes = await history.blob(vault, c.req.param("commit"), file);
    return c.json({ path: file, content: bytes.toString("utf8") });
  });

  app.post("/api/vaults/:vault/restore", async (c) => {
    const vault = await known(c, "history.restore");
    const { path: target, commit, from } = await readJson(c, restoreBody);
    const dest = normalizePath(target);
    // Restoring rewrites the file, so the folder's write rules apply as well.
    accessOf(c).requireTree("note.write", vault, dest);
    const bytes = await history.blob(vault, commit, from ? normalizePath(from) : dest);
    const author = requestAuthor(c);
    const note = requestNote(c, `Restore ${dest} to ${commit.slice(0, 7)}`);
    const written = await vaults.writeBytes(vault, dest, bytes, {
      onWritten: (r) => history.record(vault, [r.path], author, note),
    });
    return c.json({ path: written.path, version: written.version, mtime: written.mtime });
  });

  app.get("/api/vaults/:vault/checkpoints", async (c) => {
    const vault = await known(c, "history.view");
    return c.json({ checkpoints: await history.checkpoints(vault) });
  });

  app.post("/api/vaults/:vault/checkpoints", async (c) => {
    const vault = await known(c, "note.write");
    const { message, tag } = await readJson(c, checkpointBody);
    return c.json(await history.checkpoint(vault, { message, tag, author: requestAuthor(c) }), 201);
  });

  app.get("/api/vaults/:vault/backup", async (c) =>
    c.json(await backup.get(await known(c, "vault.settings"))),
  );

  app.put("/api/vaults/:vault/backup", async (c) => {
    const vault = await known(c, "vault.settings");
    const { remote, intervalMinutes } = await readJson(c, backupBody);
    return c.json(
      await backup.set(
        vault,
        remote === null ? null : { remote, intervalMinutes },
        requestAuthor(c),
      ),
    );
  });

  app.post("/api/vaults/:vault/backup/push", async (c) => {
    const vault = await known(c, "vault.settings");
    await backup.push(vault);
    return c.json(await backup.get(vault));
  });

  return app;
}

function normalizePath(path: string): string {
  try {
    return normalizeVaultPath(path);
  } catch {
    throw new AppError("invalid_path", undefined, { path });
  }
}
