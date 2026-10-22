import { Hono } from "hono";
import { z } from "zod";
import { AppError, TOKEN_ACCESS_PERMISSIONS, vaultScope } from "@palimvo/core";
import { accessOf } from "../auth/access.ts";
import { requireAccount } from "../auth/principal.ts";
import type { AuthService } from "../auth/service.ts";
import { accessOfScope, type TokenService } from "../auth/tokens.ts";
import type { ApiToken } from "../store/index.ts";
import type { VaultService } from "../vault/service.ts";
import { readJson } from "./util.ts";

export interface TokenRouteDeps {
  auth: AuthService;
  tokens: TokenService;
  vaults: VaultService;
}

const createBody = z.object({
  name: z.string().max(200),
  access: z.enum(["read", "write", "propose"]),
  vaultId: z.string().max(100).optional(),
  folders: z.array(z.string().max(1100)).max(100).optional(),
  expiresInDays: z.number().nullable().optional(),
  rateLimitPerMinute: z.number().optional(),
});

/** An API token as the API shows it: never the secret or its hash. */
function view(tokens: TokenService, t: ApiToken) {
  return {
    id: t.id,
    name: t.name,
    access: t.access,
    vaultId: t.vaultId ?? null,
    folders: t.folders,
    rateLimitPerMinute: t.rateLimitPerMinute ?? null,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt ?? null,
    lastUsedAt: t.lastUsedAt ?? null,
    revokedAt: t.revokedAt ?? null,
    active: tokens.isActive(t),
  };
}

/**
 * Making and revoking AI connections: API tokens (`/api/tokens`) and the OAuth grants apps hold
 * (`/api/oauth/grants`). Only a signed-in person can use these routes, never a token, so a leaked
 * token cannot mint more of itself. People manage their own; administrators with `users.manage`
 * can list and revoke everyone's (`/api/admin/tokens`).
 */
export function tokenRoutes({ auth, tokens, vaults }: TokenRouteDeps): Hono {
  const app = new Hono();
  const store = auth.store;

  app.get("/api/tokens", (c) => {
    const p = requireAccount(c);
    return c.json({
      tokens: store.tokens.listForAccount(p.account.id).map((t) => view(tokens, t)),
    });
  });

  app.post("/api/tokens", async (c) => {
    const p = requireAccount(c);
    const access = accessOf(c);
    const body = await readJson(c, createBody);
    const all = (await vaults.listVaults()).map((v) => v.id);
    if (body.vaultId !== undefined) {
      if (!all.includes(body.vaultId)) throw new AppError("vault_not_found");
      access.requireVault("mcp.connect", body.vaultId);
      // A token cannot start out with more than its maker holds in that vault.
      const wanted = TOKEN_ACCESS_PERMISSIONS[body.access];
      if (!access.holdsAll(wanted, vaultScope(body.vaultId))) throw new AppError("forbidden");
    } else if (!access.visibleVaults(all).some((id) => access.can("mcp.connect", vaultScope(id)))) {
      throw new AppError("forbidden");
    }
    const { token, secret } = tokens.create(p.account, {
      name: body.name,
      access: body.access,
      vaultId: body.vaultId,
      folders: body.folders,
      expiresInDays: body.expiresInDays,
      rateLimitPerMinute: body.rateLimitPerMinute,
    });
    // The secret is in this response only; the server keeps its hash.
    return c.json({ token: view(tokens, token), secret }, 201, { "Cache-Control": "no-store" });
  });

  app.delete("/api/tokens/:id", (c) => {
    const p = requireAccount(c);
    const token = store.tokens.get(c.req.param("id"));
    if (!token || token.accountId !== p.account.id) throw new AppError("not_found");
    tokens.revoke(p.account, token);
    return c.body(null, 204);
  });

  app.get("/api/oauth/grants", (c) => {
    const p = requireAccount(c);
    return c.json({
      grants: store.oauth.listGrantsForAccount(p.account.id).map((g) => ({
        id: g.id,
        clientName: store.oauth.getClient(g.clientId)?.clientName ?? "",
        access: accessOfScope(g.scope),
        createdAt: g.createdAt,
        revokedAt: g.revokedAt ?? null,
      })),
    });
  });

  app.delete("/api/oauth/grants/:id", (c) => {
    const p = requireAccount(c);
    const grant = store.oauth.getGrant(c.req.param("id"));
    if (!grant || grant.accountId !== p.account.id) throw new AppError("not_found");
    if (store.oauth.revokeGrant(grant.id))
      store.audit.append({
        actorType: "account",
        actorId: p.account.id,
        actorLabel: p.account.username,
        action: "oauth.grant_revoked",
        targetType: "oauth_grant",
        targetId: grant.id,
      });
    return c.body(null, 204);
  });

  app.get("/api/admin/tokens", (c) => {
    requireAccount(c);
    accessOf(c).requireServer("users.manage");
    return c.json({
      tokens: store.tokens.listAll().map((t) => ({
        ...view(tokens, t),
        owner: store.accounts.get(t.accountId)?.username ?? null,
      })),
    });
  });

  app.delete("/api/admin/tokens/:id", (c) => {
    const p = requireAccount(c);
    accessOf(c).requireServer("users.manage");
    const token = store.tokens.get(c.req.param("id"));
    if (!token) throw new AppError("not_found");
    tokens.revoke(p.account, token);
    return c.body(null, 204);
  });

  return app;
}
