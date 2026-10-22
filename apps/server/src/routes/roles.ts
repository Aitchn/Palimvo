import { Hono, type Context } from "hono";
import {
  AppError,
  PERMISSION_NAMES,
  SERVER_MASK,
  VAULT_MASK,
  canManageRole,
  canSetRolePermissions,
  serverScope,
  highestRolePosition,
  maskOf,
  namesOf,
  type PermissionName,
} from "@palimvo/core";
import { z } from "zod";
import { accessOf } from "../auth/access.ts";
import type { AuthService } from "../auth/service.ts";
import type { PermissionOverride, Role } from "../store/index.ts";
import { auditCall, readJson } from "./util.ts";

const permissionNames = z.array(z.enum(PERMISSION_NAMES as [PermissionName, ...PermissionName[]]));
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const createBody = z.object({
  name: z.string().trim().min(1).max(40),
  color: color.optional(),
  position: z.number().int().min(0).max(1000).optional(),
  permissions: permissionNames.default([]),
  /** Vault permissions denied in every vault the holder joins (the Reader template). */
  joinDeny: permissionNames.default([]),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: color.nullable().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  permissions: permissionNames.optional(),
  joinDeny: permissionNames.optional(),
});
const overrideBody = z.object({
  subjectType: z.enum(["role", "account"]),
  subjectId: z.string().min(1).max(100),
  allow: permissionNames.default([]),
  deny: permissionNames.default([]),
});

export const describeRole = (r: Role, memberCount?: number) => ({
  id: r.id,
  name: r.name,
  ...(r.color ? { color: r.color } : {}),
  position: r.position,
  permissions: namesOf(r.permissions),
  joinDeny: namesOf(r.joinDeny),
  everyone: r.isEveryone,
  ...(memberCount === undefined ? {} : { memberCount }),
});

export const describeOverride = (o: PermissionOverride) => ({
  ...(o.folder !== undefined ? { folder: o.folder } : {}),
  subjectType: o.subjectType,
  subjectId: o.subjectId,
  allow: namesOf(o.allow),
  deny: namesOf(o.deny),
});

/** Throws if some of `names` are not valid at the level `mask` stands for. */
export function onlyWithin(names: readonly PermissionName[], mask: number, what: string): number {
  const bits = maskOf(names);
  if ((bits & ~mask) !== 0)
    throw new AppError("invalid_request", undefined, {
      issues: [{ path: what, message: "contains a permission that does not apply here" }],
    });
  return bits;
}

/**
 * Roles and server-level grants: `/api/admin/roles`, `/api/admin/users/:id/roles/:roleId` and
 * `/api/admin/permissions`. Everything here needs `roles.manage`, and a person can only change
 * roles that rank below their own highest role and hand out permissions they hold themselves.
 */
export function roleRoutes(auth: AuthService): Hono {
  const app = new Hono();
  const { store } = auth;

  const actor = (c: Context) => {
    const access = accessOf(c);
    access.requireServer("roles.manage");
    return { access, subject: access.asSubject(), data: access.dataFor() };
  };

  /** Whether the caller outranks `role`; server administrators outrank everything. */
  const rankOk = (c: Context, role: { position: number }): boolean => {
    const access = accessOf(c);
    return access.isServerAdmin || canManageRole(access.asSubject(), role, access.dataFor());
  };

  const changed = () => auth.access.invalidate();

  app.get("/api/admin/roles", (c) => {
    const access = accessOf(c);
    if (!access.can("roles.manage", serverScope)) access.requireServer("users.manage");
    return c.json({
      roles: store.roles.list().map((r) => ({
        ...describeRole(r, store.roles.memberIds(r.id).length),
        manageable: access.can("roles.manage", serverScope) && rankOk(c, r),
      })),
    });
  });

  app.post("/api/admin/roles", async (c) => {
    const { access, subject, data } = actor(c);
    const body = await readJson(c, createBody);
    const wanted = onlyWithin(body.permissions, SERVER_MASK, "permissions");
    const joinDeny = onlyWithin(body.joinDeny, VAULT_MASK, "joinDeny");
    const highest = subject ? highestRolePosition(subject, data.roles) : 0;
    const position = body.position ?? (access.isServerAdmin ? 1 : Math.max(0, highest - 1));
    if (!rankOk(c, { position }) || !canSetRolePermissions(subject, { position }, wanted, data))
      throw new AppError("forbidden");
    const role = store.roles.create({
      name: body.name,
      ...(body.color ? { color: body.color } : {}),
      position,
      permissions: wanted,
      joinDeny,
    });
    changed();
    auditCall(auth, c, "role.created", {
      targetType: "role",
      targetId: role.id,
      detail: describeRole(role),
    });
    return c.json(describeRole(role), 201);
  });

  app.patch("/api/admin/roles/:id", async (c) => {
    const { access, subject, data } = actor(c);
    const role = store.roles.require(c.req.param("id"));
    const patch = await readJson(c, patchBody);
    if (!rankOk(c, role)) throw new AppError("forbidden");
    if (role.isEveryone && (patch.name !== undefined || patch.position !== undefined))
      throw new AppError("forbidden", undefined, undefined, {
        message: "The @everyone role keeps its name and position.",
      });
    if (patch.position !== undefined && !rankOk(c, { position: patch.position }))
      throw new AppError("forbidden");
    const permissions =
      patch.permissions === undefined
        ? undefined
        : onlyWithin(patch.permissions, SERVER_MASK, "permissions");
    // Only newly added permissions need to be ones the caller holds.
    if (
      permissions !== undefined &&
      !access.isServerAdmin &&
      !canSetRolePermissions(subject, role, permissions & ~role.permissions, data)
    )
      throw new AppError("forbidden");
    const joinDeny =
      patch.joinDeny === undefined ? undefined : onlyWithin(patch.joinDeny, VAULT_MASK, "joinDeny");
    const updated = store.roles.update(role.id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
      ...(joinDeny !== undefined ? { joinDeny } : {}),
    });
    changed();
    auditCall(auth, c, "role.updated", { targetType: "role", targetId: role.id, detail: patch });
    return c.json(describeRole(updated));
  });

  app.delete("/api/admin/roles/:id", (c) => {
    actor(c);
    const role = store.roles.require(c.req.param("id"));
    if (!rankOk(c, role)) throw new AppError("forbidden");
    store.roles.delete(role.id);
    changed();
    auditCall(auth, c, "role.deleted", {
      targetType: "role",
      targetId: role.id,
      detail: { name: role.name },
    });
    return c.body(null, 204);
  });

  app.put("/api/admin/users/:id/roles/:roleId", (c) => {
    actor(c);
    const role = store.roles.require(c.req.param("roleId"));
    if (role.isEveryone)
      throw new AppError("invalid_request", undefined, { reason: "everyone has this role" });
    if (!rankOk(c, role)) throw new AppError("forbidden");
    const id = store.accounts.require(c.req.param("id")).id;
    store.grantRole(role.id, id);
    changed();
    auditCall(auth, c, "role.assigned", {
      targetType: "account",
      targetId: id,
      detail: { role: role.id },
    });
    return c.body(null, 204);
  });

  app.delete("/api/admin/users/:id/roles/:roleId", (c) => {
    actor(c);
    const role = store.roles.require(c.req.param("roleId"));
    if (!rankOk(c, role)) throw new AppError("forbidden");
    const id = store.accounts.require(c.req.param("id")).id;
    if (!store.roles.unassign(role.id, id)) throw new AppError("not_found");
    changed();
    auditCall(auth, c, "role.unassigned", {
      targetType: "account",
      targetId: id,
      detail: { role: role.id },
    });
    return c.body(null, 204);
  });

  app.get("/api/admin/permissions", (c) => {
    actor(c);
    return c.json({ overrides: store.roles.serverOverrides().map(describeOverride) });
  });

  app.put("/api/admin/permissions", async (c) => {
    const { access } = actor(c);
    const body = await readJson(c, overrideBody);
    const allow = onlyWithin(body.allow, SERVER_MASK, "allow");
    const deny = onlyWithin(body.deny, SERVER_MASK, "deny");
    if (body.subjectType === "role") {
      const role = store.roles.require(body.subjectId);
      if (!rankOk(c, role)) throw new AppError("forbidden");
    } else store.accounts.require(body.subjectId);
    if (!access.isServerAdmin && (allow & ~access.mask(serverScope)) !== 0)
      throw new AppError("forbidden");
    const target = {
      scope: "server",
      subjectType: body.subjectType,
      subjectId: body.subjectId,
    } as const;
    if (allow === 0 && deny === 0) store.roles.deleteOverride(target);
    else store.roles.setOverride(target, { allow, deny });
    changed();
    auditCall(auth, c, "permission.server_set", {
      targetType: body.subjectType,
      targetId: body.subjectId,
      detail: { allow: body.allow, deny: body.deny },
    });
    return c.json({ overrides: store.roles.serverOverrides().map(describeOverride) });
  });

  app.delete("/api/admin/permissions", (c) => {
    actor(c);
    const subjectType = z.enum(["role", "account"]).safeParse(c.req.query("subjectType"));
    const subjectId = c.req.query("subjectId");
    if (!subjectType.success || !subjectId) throw new AppError("invalid_request");
    if (subjectType.data === "role" && !rankOk(c, store.roles.require(subjectId)))
      throw new AppError("forbidden");
    const found = store.roles.deleteOverride({
      scope: "server",
      subjectType: subjectType.data,
      subjectId,
    });
    if (!found) throw new AppError("not_found");
    changed();
    auditCall(auth, c, "permission.server_cleared", {
      targetType: subjectType.data,
      targetId: subjectId,
    });
    return c.body(null, 204);
  });

  return app;
}
