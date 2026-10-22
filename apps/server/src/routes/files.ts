import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@palimvo/core";
import { z } from "zod";
import type { VaultHistory } from "../history/history.ts";
import { MAX_TEXT_BYTES } from "../vault/fsutil.ts";
import { MAX_BATCH_BYTES, type VaultService } from "../vault/service.ts";
import { guestPolicy } from "../auth/principal.ts";
import type { AuthService } from "../auth/service.ts";
import { requestAuthor, requestNote } from "./author.ts";
import { readJson } from "./util.ts";

const JSON_OVERHEAD = 1024 * 1024;

const putBody = z.object({
  content: z.string(),
  /** The version the client last saw; `null`: the file must not exist yet. Leave out to overwrite. */
  baseVersion: z.string().nullable().optional(),
});
const folderBody = z.object({ path: z.string() });
const moveBody = z.object({ from: z.string(), to: z.string() });
const batchBody = z.object({
  writes: z
    .array(z.object({ path: z.string(), baseVersion: z.string().nullable(), content: z.string() }))
    .max(500),
});

/** The file path after `/files/`, percent-decoded exactly once. */
function filePathOf(c: Context): string {
  const raw = new URL(c.req.url).pathname;
  const rest = raw.slice(raw.indexOf("/files/") + "/files/".length);
  try {
    return decodeURIComponent(rest);
  } catch {
    throw new AppError("invalid_path", undefined, { path: rest });
  }
}

/** `If-None-Match` hit: the client already has this exact version. */
function notModified(c: Context, tag: string): boolean {
  return (
    c.req
      .header("if-none-match")
      ?.split(",")
      .some((t) => t.trim().replace(/^W\//, "") === tag) ?? false
  );
}

/**
 * File tree, reading, writing, moving and deleting inside a vault: `/api/vaults/:vault/…`.
 * Every change is recorded with `history` (who made it and why) while the vault's write queue
 * is still held, so a commit never separates a change from its author.
 */
export function fileRoutes(vaults: VaultService, history: VaultHistory, auth: AuthService): Hono {
  const app = new Hono();

  app.get("/api/vaults/:vault/files", async (c) => {
    const vault = c.req.param("vault");
    const policy = guestPolicy(auth, c, vault);
    if (policy) {
      // Guests get a filtered tree; no ETag, since the public set can change without the tree changing.
      // A vault without public content looks the same as one that does not exist.
      if (!policy.any) throw new AppError("vault_not_found");
      c.header("Cache-Control", "no-store");
      return c.json({ tree: policy.filterTree(await vaults.tree(vault)) });
    }
    const tag = `"${await vaults.treeTag(vault)}"`;
    c.header("ETag", tag);
    c.header("Cache-Control", "no-cache");
    if (notModified(c, tag)) return c.body(null, 304);
    return c.json({ tree: await vaults.tree(vault) });
  });

  app.get("/api/vaults/:vault/files/*", async (c) => {
    const vault = c.req.param("vault");
    const target = filePathOf(c);
    const policy = guestPolicy(auth, c, vault);
    if (policy && !policy.covers(target)) throw new AppError("not_found");
    const file = await vaults.readFile(vault, target);
    if (policy) c.header("Cache-Control", "no-store");
    const tag = `"${file.version}"`;
    c.header("ETag", tag);
    c.header("Cache-Control", "no-cache");
    if (notModified(c, tag)) return c.body(null, 304);
    return c.json(file);
  });

  app.put(
    "/api/vaults/:vault/files/*",
    bodyLimit({ maxSize: MAX_TEXT_BYTES + JSON_OVERHEAD, onError: tooLarge }),
    async (c) => {
      const { content, baseVersion } = await readJson(c, putBody);
      const vault = c.req.param("vault");
      const author = requestAuthor(c);
      const note = requestNote(c);
      const file = await vaults.writeFile(vault, filePathOf(c), content, {
        baseVersion,
        onWritten: (written) => history.record(vault, [written.path], author, note),
      });
      return c.json({ path: file.path, version: file.version, mtime: file.mtime });
    },
  );

  app.delete("/api/vaults/:vault/files/*", async (c) => {
    const vault = c.req.param("vault");
    const target = filePathOf(c);
    const author = requestAuthor(c);
    const note = requestNote(c, `Delete ${target}`);
    await vaults.deleteFile(vault, target, (paths) => history.record(vault, paths, author, note));
    return c.body(null, 204);
  });

  app.post("/api/vaults/:vault/folders", async (c) => {
    const { path } = await readJson(c, folderBody);
    const vault = c.req.param("vault");
    const author = requestAuthor(c);
    const note = requestNote(c, `Create folder ${path}`);
    const created = await vaults.createFolder(vault, path, (placeholder) =>
      history.record(vault, [placeholder], author, note),
    );
    return c.json(created, 201);
  });

  app.post("/api/vaults/:vault/move", async (c) => {
    const { from, to } = await readJson(c, moveBody);
    const vault = c.req.param("vault");
    const author = requestAuthor(c);
    const note = requestNote(c, `Move ${from} to ${to}`);
    return c.json(
      await vaults.move(vault, from, to, (moved) =>
        history.record(vault, moved.flat(), author, note),
      ),
    );
  });

  app.post(
    "/api/vaults/:vault/batch",
    bodyLimit({ maxSize: MAX_BATCH_BYTES + JSON_OVERHEAD, onError: tooLarge }),
    async (c) => {
      const { writes } = await readJson(c, batchBody);
      const vault = c.req.param("vault");
      const author = requestAuthor(c);
      const note = requestNote(c);
      const files = await vaults.writeBatch(vault, writes, {
        onWritten: (results) =>
          history.record(
            vault,
            results.map((r) => r.path),
            author,
            note,
          ),
      });
      return c.json({ files });
    },
  );

  return app;
}

function tooLarge(): never {
  throw new AppError("payload_too_large");
}
