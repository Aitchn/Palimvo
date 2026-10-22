import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AppError,
  normalizeVaultPath,
  DEFAULT_MAX_FILE_BYTES,
  MAX_CHUNKED_FILE_BYTES,
} from "@palimvo/core";
import { z } from "zod";
import { accessOf } from "../auth/access.ts";
import { publicBase, uploadCommands, uploadLinkPath } from "../files/linkScripts.ts";
import type { UploadLinks } from "../files/links.ts";
import { UPLOAD_PART_BYTES } from "../files/sessions.ts";
import type { FileTransfers } from "../files/transfers.ts";
import { requestAuthor, requestNote } from "./author.ts";
import { readJson } from "./util.ts";

const beginBody = z.object({
  path: z.string(),
  size: z.number().int().min(0),
  create: z.boolean().optional(),
});
const linkBody = z.object({ path: z.string(), create: z.boolean().optional() });

function treePath(raw: string): string {
  try {
    return normalizeVaultPath(raw);
  } catch {
    throw new AppError("invalid_path", undefined, { path: raw });
  }
}

/** The file path after `/raw/`, percent-decoded exactly once. */
function rawPathOf(c: Context): string {
  // By position, not by searching for "/raw/": a vault may itself be called "raw".
  const rest = new URL(c.req.url).pathname.split("/").slice(5).join("/");
  try {
    return decodeURIComponent(rest);
  } catch {
    throw new AppError("invalid_path", undefined, { path: rest });
  }
}

function tooLarge(limit: number) {
  return (): never => {
    throw new AppError("payload_too_large", undefined, { limit });
  };
}

export interface UploadRouteOptions {
  transfers: FileTransfers;
  links: UploadLinks;
  publicUrl: string | undefined;
  trustProxy: boolean;
}

/**
 * Signed-in uploads: `PUT …/raw/<path>` for a file that fits in one request, resumable parts
 * under `…/uploads` for bigger ones, and `…/upload-links` to make a link for a program or person
 * without an account. What may be uploaded is decided by the vault's file types.
 */
export function uploadRoutes(options: UploadRouteOptions): Hono {
  const { transfers, links } = options;
  const app = new Hono();

  /** What a vault accepts: limits and the types enabled plugins add. */
  app.get("/api/vaults/:vault/file-types", async (c) => {
    const vault = c.req.param("vault");
    accessOf(c).requireVault("vault.view", vault);
    await transfers.vaults.assertVault(vault);
    return c.json({
      maxBytes: DEFAULT_MAX_FILE_BYTES,
      maxBytesChunked: MAX_CHUNKED_FILE_BYTES,
      partBytes: UPLOAD_PART_BYTES,
      plugins: transfers.policy.pluginTypes(vault).map((t) => ({
        extension: t.extension,
        mime: t.mime,
        maxBytes: t.maxBytes,
        description: t.description ?? null,
        plugins: t.plugins,
      })),
    });
  });

  app.put(
    "/api/vaults/:vault/raw/*",
    bodyLimit({ maxSize: DEFAULT_MAX_FILE_BYTES, onError: tooLarge(DEFAULT_MAX_FILE_BYTES) }),
    async (c) => {
      const vault = c.req.param("vault");
      const target = treePath(rawPathOf(c));
      accessOf(c).requireTree("file.upload", vault, target);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const written = await transfers.upload(vault, target, bytes, {
        create: c.req.query("create") === "1",
        actor: { author: requestAuthor(c), note: requestNote(c) },
      });
      return c.json(
        { path: written.path, size: written.size, version: written.version, mtime: written.mtime },
        201,
      );
    },
  );

  app.post("/api/vaults/:vault/uploads", async (c) => {
    const { path, size, create } = await readJson(c, beginBody);
    const vault = c.req.param("vault");
    const target = treePath(path);
    accessOf(c).requireTree("file.upload", vault, target);
    return c.json(await transfers.begin(vault, target, size, { create: create ?? false }), 201);
  });

  /** Looks the upload up and checks the caller may upload where it is going. */
  const owned = async (c: Context) => {
    const vault = c.req.param("vault") ?? "";
    const id = c.req.param("id") ?? "";
    const status = await transfers.sessions.status(vault, id);
    accessOf(c).requireTree("file.upload", vault, status.path);
    return { vault, id, status };
  };

  app.get("/api/vaults/:vault/uploads/:id", async (c) => c.json((await owned(c)).status));

  app.put(
    "/api/vaults/:vault/uploads/:id",
    bodyLimit({ maxSize: UPLOAD_PART_BYTES, onError: tooLarge(UPLOAD_PART_BYTES) }),
    async (c) => {
      const { vault, id } = await owned(c);
      const offset = Number(c.req.query("offset"));
      return c.json(await transfers.sessions.part(vault, id, offset, c.req.raw.body));
    },
  );

  app.post("/api/vaults/:vault/uploads/:id/finish", async (c) => {
    const { vault, id } = await owned(c);
    const saved = await transfers.finish(vault, id, {
      author: requestAuthor(c),
      note: requestNote(c),
    });
    return c.json({ path: saved.path, size: saved.size, version: saved.version }, 201);
  });

  app.delete("/api/vaults/:vault/uploads/:id", async (c) => {
    const { vault, id } = await owned(c);
    await transfers.sessions.cancel(vault, id);
    return c.body(null, 204);
  });

  app.post("/api/vaults/:vault/upload-links", async (c) => {
    const { path, create } = await readJson(c, linkBody);
    const vault = c.req.param("vault");
    const target = treePath(path);
    accessOf(c).requireTree("file.upload", vault, target);
    const note = requestNote(c);
    const made = await links.create(vault, target, {
      create: create ?? true,
      author: requestAuthor(c),
      ...(note.reason ? { reason: note.reason } : {}),
    });
    const url = `${publicBase(c, options.publicUrl, options.trustProxy)}${uploadLinkPath(made.token)}`;
    return c.json(
      { url, path: made.path, expiresAt: made.expiresAt, commands: uploadCommands(url) },
      201,
    );
  });

  return app;
}
