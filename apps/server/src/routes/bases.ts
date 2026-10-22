import { Hono } from "hono";
import {
  AppError,
  BaseError,
  dirname,
  fileKind,
  folderScope,
  InvalidPathError,
  normalizeVaultPath,
  setNoteProperty,
} from "@palimvo/core";
import { z } from "zod";
import { accessOf } from "../auth/access.ts";
import { guestPolicy } from "../auth/principal.ts";
import type { AuthService } from "../auth/service.ts";
import { runBase } from "../bases/query.ts";
import type { VaultHistory } from "../history/history.ts";
import { KeyedMutex } from "../vault/mutex.ts";
import type { VaultService } from "../vault/service.ts";
import { requestAuthor, requestNote } from "./author.ts";
import { readJson } from "./util.ts";

/** A path from the request as the vault wants it; a bad one is `invalid_path`. */
export function cleanPath(raw: string): string {
  try {
    return normalizeVaultPath(raw);
  } catch (err) {
    if (err instanceof InvalidPathError)
      throw new AppError("invalid_path", undefined, { path: raw }, { message: err.message });
    throw err;
  }
}

const MAX_SOURCE_LENGTH = 256 * 1024;
const MAX_ATTEMPTS = 8;

const queryBody = z.object({
  path: z.string().optional(),
  source: z.string().max(MAX_SOURCE_LENGTH).optional(),
  thisPath: z.string().optional(),
  view: z.union([z.string(), z.number().int().min(0)]).optional(),
  columns: z.array(z.string().max(300)).max(100).optional(),
});

const propertyBody = z.object({
  path: z.string(),
  key: z.string().min(1).max(200),
  value: z.unknown(),
});

/**
 * Databases (.base): `/api/vaults/:vault/bases/…`. Querying needs only read access (guests see rows
 * of public notes only); changing a cell writes the note's frontmatter, so it needs write access.
 */
export function baseRoutes(vaults: VaultService, history: VaultHistory, auth: AuthService): Hono {
  const app = new Hono();
  /** Editing a cell is a read, change, write of the note; concurrent edits of one note queue up. */
  const cellEdits = new KeyedMutex();

  app.post("/api/vaults/:vault/bases/query", async (c) => {
    const vault = c.req.param("vault");
    accessOf(c).requireVault("note.read", vault);
    await vaults.assertVault(vault);
    const body = await readJson(c, queryBody);
    const policy = guestPolicy(auth, c, vault);
    if (policy && !policy.any) throw new AppError("vault_not_found");
    const access = accessOf(c);
    // A token limited to folders sees only notes in them.
    const limited = (access.bearer?.scope.folders?.length ?? 0) > 0;
    const include = policy
      ? (p: string) => policy.covers(p)
      : limited
        ? (p: string) => access.can("note.read", folderScope(vault, dirname(p)))
        : undefined;
    if (include && body.path !== undefined) {
      const target = cleanPath(body.path);
      // A public-looking path may be a link to a private file; like the file route, only direct paths count for guests.
      if (!include(target) || (policy && !(await vaults.isDirectPath(vault, target))))
        throw new AppError("not_found");
    }
    const result = await runBase(vaults, vault, body, include);
    if (policy) c.header("Cache-Control", "no-store");
    return c.json(result);
  });

  app.post("/api/vaults/:vault/bases/property", async (c) => {
    const vault = c.req.param("vault");
    const { path: raw, key, value } = await readJson(c, propertyBody);
    const path = cleanPath(raw);
    accessOf(c).requireTree("note.write", vault, path);
    if (fileKind(path) !== "markdown")
      throw new AppError(
        "invalid_request",
        undefined,
        { path },
        { message: `${path} is not a Markdown note` },
      );
    const author = requestAuthor(c);
    const note = requestNote(c, `Set ${key} of ${path}`);
    const written = await cellEdits.run(`${vault}\0${path}`, async () => {
      let last: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const file = await vaults.readFile(vault, path, { fresh: attempt > 0 });
        let next: string;
        try {
          next = setNoteProperty(file.content, key, value);
        } catch (err) {
          if (err instanceof BaseError)
            throw new AppError("invalid_request", undefined, undefined, { message: err.message });
          throw err;
        }
        if (next === file.content) return { path, version: file.version, mtime: file.mtime };
        try {
          const result = await vaults.writeFile(vault, path, next, {
            baseVersion: file.version,
            onWritten: (w) => history.record(vault, [w.path], author, note),
          });
          return { path: result.path, version: result.version, mtime: result.mtime };
        } catch (err) {
          if (!(err instanceof AppError) || err.code !== "version_conflict") throw err;
          last = err;
        }
      }
      throw last;
    });
    return c.json(written);
  });

  return app;
}
