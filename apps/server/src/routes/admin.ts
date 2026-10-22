import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { AppError, canManageRole } from "@palimvo/core";
import { z } from "zod";
import { accessOf } from "../auth/access.ts";
import { requireAccount } from "../auth/principal.ts";
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

/**
 * Accounts and invites: `/api/admin/*`. Needs `users.manage`. Only a server administrator may
 * create, change or touch another server administrator; people with `users.manage` alone cannot
 * use these routes to raise themselves or anyone else.
 */
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

  /** The caller; must hold `users.manage`. */
  const manager = (c: Context) => {
    accessOf(c).requireServer("users.manage");
    return requireAccount(c).account;
  };

  /** Server administrators are off limits to people who are not one themselves. */
  const guardTarget = (c: Context, targetId: string) => {
    if (!accessOf(c).isServerAdmin && store.accounts.require(targetId).serverAdmin)
      throw new AppError("forbidden");
  };

  /** Server administrators and the vault's own administrators. */
  const isVaultAdmin = (c: Context, vaultId: string) => {
    const access = accessOf(c);
    return (
      access.isServerAdmin ||
      (access.accountId !== undefined &&
        store.accounts.getMember(vaultId, access.accountId)?.position === "admin")
    );
  };

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
    manager(c);
    return c.json({ users: store.accounts.list().map((a) => describe(a.id)) });
  });

  app.post("/api/admin/users", async (c) => {
    const admin = manager(c);
    const body = await readJson(c, createUserBody);
    if (body.serverAdmin && !accessOf(c).isServerAdmin) throw new AppError("forbidden");
    const created = await auth.createAccount(body);
    audit(admin, "admin.user_created", created.id, { username: created.username });
    return c.json(describe(created.id), 201);
  });

  app.patch("/api/admin/users/:id", async (c) => {
    const admin = manager(c);
    const id = c.req.param("id");
    const patch = await readJson(c, patchUserBody);
    guardTarget(c, id);
    if (patch.serverAdmin !== undefined && !accessOf(c).isServerAdmin)
      throw new AppError("forbidden");
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
    const admin = manager(c);
    const id = c.req.param("id");
    const { password } = await readJson(c, resetBody);
    store.accounts.require(id);
    guardTarget(c, id);
    // No password given: make a temporary one the administrator hands over.
    const next = password ?? randomBytes(12).toString("base64url");
    await auth.resetPassword(admin, id, next);
    return c.json(password === undefined ? { password: next } : {});
  });

  app.delete("/api/admin/users/:id", (c) => {
    const admin = manager(c);
    const id = c.req.param("id");
    if (id === admin.id)
      throw new AppError("forbidden", undefined, undefined, {
        message: "You cannot delete your own account.",
      });
    guardTarget(c, id);
    store.accounts.delete(id);
    auth.access.invalidate();
    audit(admin, "admin.user_deleted", id);
    return c.body(null, 204);
  });

  app.get("/api/admin/invites", (c) => {
    manager(c);
    const now = Date.now();
    return c.json({
      invites: store.invites.list().map((i) => ({ ...i, expired: i.expiresAt <= now })),
    });
  });

  app.post("/api/admin/invites", async (c) => {
    const admin = manager(c);
    const body = await readJson(c, inviteBody);
    const access = accessOf(c);
    for (const v of body.vaults ?? []) {
      await vaults.assertVault(v.vaultId);
      access.requireVault("members.manage", v.vaultId);
      // Only a vault's administrator (or a server administrator) can make another one.
      if (v.position === "admin" && !isVaultAdmin(c, v.vaultId)) throw new AppError("forbidden");
    }
    for (const id of body.roleIds ?? []) {
      const role = store.roles.require(id);
      if (!canManageRole(access.asSubject(), role, access.dataFor()))
        throw new AppError("forbidden");
    }
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
    const admin = manager(c);
    if (!store.invites.delete(c.req.param("id"))) throw new AppError("not_found");
    audit(admin, "admin.invite_revoked", undefined, { invite: c.req.param("id") });
    return c.body(null, 204);
  });

  return app;
}
