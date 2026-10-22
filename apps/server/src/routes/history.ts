import { Hono } from "hono";
import { AppError, normalizeVaultPath } from "@palimvo/core";
import { z } from "zod";
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

  /** Fails with `vault_not_found` before git is asked about a vault that does not exist. */
  const known = async (vault: string) => {
    await vaults.assertVault(vault);
    return vault;
  };

  app.get("/api/vaults/:vault/history", async (c) => {
    const vault = await known(c.req.param("vault"));
    const limit = Number(c.req.query("limit") ?? 50);
    const commits = await history.list(vault, {
      ...(c.req.query("path") ? { path: normalizePath(c.req.query("path")!) } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({ commits });
  });

  app.get("/api/vaults/:vault/history/:commit/diff", async (c) => {
    const vault = await known(c.req.param("vault"));
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
    const vault = await known(c.req.param("vault"));
    const file = normalizePath(c.req.query("path") ?? "");
    const bytes = await history.blob(vault, c.req.param("commit"), file);
    return c.json({ path: file, content: bytes.toString("utf8") });
  });

  app.post("/api/vaults/:vault/restore", async (c) => {
    const vault = await known(c.req.param("vault"));
    const { path: target, commit, from } = await readJson(c, restoreBody);
    const dest = normalizePath(target);
    const bytes = await history.blob(vault, commit, from ? normalizePath(from) : dest);
    const author = requestAuthor(c);
    const note = requestNote(c, `Restore ${dest} to ${commit.slice(0, 7)}`);
    const written = await vaults.writeBytes(vault, dest, bytes, {
      onWritten: (r) => history.record(vault, [r.path], author, note),
    });
    return c.json({ path: written.path, version: written.version, mtime: written.mtime });
  });

  app.get("/api/vaults/:vault/checkpoints", async (c) => {
    const vault = await known(c.req.param("vault"));
    return c.json({ checkpoints: await history.checkpoints(vault) });
  });

  app.post("/api/vaults/:vault/checkpoints", async (c) => {
    const vault = await known(c.req.param("vault"));
    const { message, tag } = await readJson(c, checkpointBody);
    return c.json(await history.checkpoint(vault, { message, tag, author: requestAuthor(c) }), 201);
  });

  app.get("/api/vaults/:vault/backup", async (c) =>
    c.json(await backup.get(await known(c.req.param("vault")))),
  );

  app.put("/api/vaults/:vault/backup", async (c) => {
    const vault = await known(c.req.param("vault"));
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
    const vault = await known(c.req.param("vault"));
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
