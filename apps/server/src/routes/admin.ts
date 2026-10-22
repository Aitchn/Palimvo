import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { AppError } from "@palimvo/core";
import { z } from "zod";
import { requireServerAdmin } from "../auth/principal.ts";
import { publicAccount, type AuthService } from "../auth/service.ts";
import type { VaultService } from "../vault/service.ts";
import { readJson } from "./util.ts";

export interface AdminRouteDeps {
  auth: AuthService;
  vaults: VaultService;
  publicUrl?: string;
}

const createUserBody = z.object({
  username: z.string().max(100),
  password: z.string().max(1000),
  displayName: z.string().max(80).optional(),
  serverAdmin: z.boolean().optional(),
});
const patchUserBody = z.object({
  displayName: z.string().min(1).max(80).optional(),
  disabled: z.boolean().optional(),
  serverAdmin: z.boolean().optional(),
});
const resetBody = z.object({ password: z.string().max(1000).optional() });
const inviteBody = z.object({
  note: z.string().max(200).optional(),
  roleIds: z.array(z.string()).max(50).optional(),
  vaults: z
    .array(z.object({ vaultId: z.string(), position: z.enum(["admin", "member"]) }))
    .max(100)
    .optional(),
  expiresInHours: z
    .number()
    .min(1)
    .max(24 * 30)
    .optional(),
});

/** Accounts and invites for server administrators: `/api/admin/*`. Roles replace the admin check in T52. */
export function adminRoutes({ auth, vaults, publicUrl }: AdminRouteDeps): Hono {
  const app = new Hono();
  const { store } = auth;

  const audit = (
    actor: { id: string; username: string },
    action: string,
    targetId?: string,
    detail?: unknown,
  ) =>
    store.audit.append({
      actorType: "account",
      actorId: actor.id,
      actorLabel: actor.username,
      action,
      ...(targetId ? { targetType: "account", targetId } : {}),
      ...(detail === undefined ? {} : { detail }),
    });

  const describe = (id: string) => {
    const account = store.accounts.require(id);
    return {
      ...publicAccount(account),
      roles: store.roles.rolesOf(id).map((r) => ({ id: r.id, name: r.name })),
      vaults: store.accounts
        .listMemberships(id)
        .map((m) => ({ vaultId: m.vaultId, position: m.position })),
    };
  };

  app.get("/api/admin/users", (c) => {
    requireServerAdmin(c);
    return c.json({ users: store.accounts.list().map((a) => describe(a.id)) });
  });

  app.post("/api/admin/users", async (c) => {
    const admin = requireServerAdmin(c).account;
    const body = await readJson(c, createUserBody);
    const created = await auth.createAccount(body);
    audit(admin, "admin.user_created", created.id, { username: created.username });
    return c.json(describe(created.id), 201);
  });

  app.patch("/api/admin/users/:id", async (c) => {
    const admin = requireServerAdmin(c).account;
    const id = c.req.param("id");
    const patch = await readJson(c, patchUserBody);
    if (id === admin.id && (patch.disabled === true || patch.serverAdmin === false))
      throw new AppError("forbidden", undefined, undefined, {
        message: "You cannot disable or demote your own account.",
      });
    store.tx(() => {
      store.accounts.update(id, patch);
      if (patch.disabled === true) store.sessions.deleteForAccount(id);
    });
    audit(admin, "admin.user_updated", id, patch);
    return c.json(describe(id));
  });

  app.post("/api/admin/users/:id/password", async (c) => {
    const admin = requireServerAdmin(c).account;
    const id = c.req.param("id");
    const { password } = await readJson(c, resetBody);
    store.accounts.require(id);
    // No password given: make a temporary one the administrator hands over.
    const next = password ?? randomBytes(12).toString("base64url");
    await auth.resetPassword(admin, id, next);
    return c.json(password === undefined ? { password: next } : {});
  });

  app.delete("/api/admin/users/:id", (c) => {
    const admin = requireServerAdmin(c).account;
    const id = c.req.param("id");
    if (id === admin.id)
      throw new AppError("forbidden", undefined, undefined, {
        message: "You cannot delete your own account.",
      });
    store.accounts.delete(id);
    audit(admin, "admin.user_deleted", id);
    return c.body(null, 204);
  });

  app.get("/api/admin/invites", (c) => {
    requireServerAdmin(c);
    const now = Date.now();
    return c.json({
      invites: store.invites.list().map((i) => ({ ...i, expired: i.expiresAt <= now })),
    });
  });

  app.post("/api/admin/invites", async (c) => {
    const admin = requireServerAdmin(c).account;
    const body = await readJson(c, inviteBody);
    for (const v of body.vaults ?? []) await vaults.assertVault(v.vaultId);
    const { invite, token } = auth.createInvite({
      createdBy: admin.id,
      ...(body.note ? { note: body.note } : {}),
      ...(body.roleIds ? { roleIds: body.roleIds } : {}),
      ...(body.vaults ? { vaults: body.vaults } : {}),
      ...(body.expiresInHours ? { ttlMs: body.expiresInHours * 3_600_000 } : {}),
    });
    audit(admin, "admin.invite_created", undefined, { invite: invite.id });
    const origin = publicUrl ?? new URL(c.req.url).origin;
    return c.json({ invite, token, url: `${origin}/invite/${token}` }, 201);
  });

  app.delete("/api/admin/invites/:id", (c) => {
    const admin = requireServerAdmin(c).account;
    if (!store.invites.delete(c.req.param("id"))) throw new AppError("not_found");
    audit(admin, "admin.invite_revoked", undefined, { invite: c.req.param("id") });
    return c.body(null, 204);
  });

  return app;
}
