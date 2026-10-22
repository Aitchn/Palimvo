import { Hono } from "hono";
import { AppError, InvalidPathError, normalizeVaultPath } from "@palimvo/core";
import { z } from "zod";
import { accessOf } from "../auth/access.ts";
import { guestPolicy } from "../auth/principal.ts";
import type { AuthService } from "../auth/service.ts";
import type { VaultIndexes } from "../search/index.ts";
import type { VaultService } from "../vault/service.ts";

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 200;
const MAX_QUERY_LENGTH = 500;

const searchQuery = z.object({
  q: z.string().max(MAX_QUERY_LENGTH),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  /** Only search below this folder. */
  path: z.string().optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("invalid_request", undefined, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

function normalize(raw: string): string {
  try {
    return normalizeVaultPath(raw);
  } catch (err) {
    if (err instanceof InvalidPathError)
      throw new AppError("invalid_path", undefined, { path: raw }, { message: err.message });
    throw err;
  }
}

/** The `path` query parameter, as a normalized vault path. */
function pathParam(raw: string | undefined): string {
  if (raw === undefined)
    throw new AppError("invalid_request", undefined, {
      issues: [{ path: "path", message: "required" }],
    });
  return normalize(raw);
}

/**
 * Search, backlinks, outgoing links and the link graph of a vault: `/api/vaults/:vault/…`.
 * Guests search only the public part of the vault; backlinks, links and the graph need a sign-in.
 */
export function searchRoutes(vaults: VaultService, indexes: VaultIndexes, auth: AuthService): Hono {
  const app = new Hono();

  app.get("/api/vaults/:vault/search", async (c) => {
    const vault = c.req.param("vault");
    accessOf(c).requireVault("note.read", vault);
    await vaults.assertVault(vault);
    const { q, limit, offset, path } = parse(searchQuery, c.req.query());
    const folder = path === undefined || path.trim() === "" ? undefined : normalize(path);
    const policy = guestPolicy(auth, c, vault);
    if (policy && !policy.any) throw new AppError("vault_not_found");
    if (policy) {
      // The index filters before counting and paging, so totals never include what guests may not see.
      const include = (p: string) => policy.covers(p);
      return c.json(await indexes.search.search(vault, q, { limit, offset, folder, include }));
    }
    return c.json(await indexes.search.search(vault, q, { limit, offset, folder }));
  });

  app.get("/api/vaults/:vault/backlinks", async (c) => {
    const vault = c.req.param("vault");
    accessOf(c).requireVault("note.read", vault);
    await vaults.assertVault(vault);
    return c.json({
      backlinks: await indexes.links.backlinks(vault, pathParam(c.req.query("path"))),
    });
  });

  app.get("/api/vaults/:vault/links", async (c) => {
    const vault = c.req.param("vault");
    accessOf(c).requireVault("note.read", vault);
    await vaults.assertVault(vault);
    return c.json({ links: await indexes.links.outlinks(vault, pathParam(c.req.query("path"))) });
  });

  app.get("/api/vaults/:vault/graph", async (c) => {
    const vault = c.req.param("vault");
    accessOf(c).requireVault("note.read", vault);
    await vaults.assertVault(vault);
    return c.json(await indexes.links.graph(vault));
  });

  return app;
}
