import { Hono, type Context } from "hono";
import {
  AppError,
  FOLDER_MASK,
  InvalidPathError,
  VAULT_MASK,
  folderScope,
  isPermissionName,
  makeAuthor,
  namesOf,
  resolvePermissions,
  normalizeVaultPath,
  vaultScope,
  type PermissionSubject,
} from "@palimvo/core";
import { z } from "zod";
import { accessOf } from "../auth/access.ts";
import { publicAccount, type AuthService } from "../auth/service.ts";
import type { VaultService } from "../vault/service.ts";
import { describeOverride, onlyWithin } from "./roles.ts";
import { auditCall, readJson } from "./util.ts";

const positionBody = z.object({ position: z.enum(["admin", "member"]) });
const putBody = z.object({
  /** Leave out for a vault-wide override. */
  folder: z.string().max(1000).optional(),
  subjectType: z.enum(["role", "account"]),
  subjectId: z.string().min(1).max(100),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});

function folderOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === "" || raw === "/") throw new AppError("invalid_path", undefined, { path: raw });
  try {
    return normalizeVaultPath(raw);
  } catch (err) {
    if (err instanceof InvalidPathError)
      throw new AppError("invalid_path", undefined, { path: raw });
    throw err;
  }
}

/**
 * Who belongs to a vault and what the vault's roles and people may do inside it:
 * `/api/vaults/:vault/members`, `/api/vaults/:vault/permissions` and `/api/me/permissions`.
 */
export function memberRoutes(auth: AuthService, vaults: VaultService): Hono {
  const app = new Hono();
  const { store } = auth;

  const known = async (c: Context, permission: "members.manage" | "permissions.manage") => {
    const vault = c.req.param("vault")!;
    accessOf(c).requireVault(permission, vault);
    await vaults.assertVault(vault);
    return vault;
  };

  /** Server administrators and the vault's own administrators may touch other administrators. */
  const mayTouchAdmins = (c: Context, vault: string): boolean => {
    const access = accessOf(c);
    return (
      access.isServerAdmin ||
      (access.accountId !== undefined &&
        store.accounts.getMember(vault, access.accountId)?.position === "admin")
    );
  };

  const describeMember = (vault: string, accountId: string) => {
    const member = store.accounts.getMember(vault, accountId)!;
    return {
      account: publicAccount(store.accounts.require(accountId)),
      position: member.position,
      addedAt: member.addedAt,
      roles: store.roles.rolesOf(accountId).map((r) => ({
        id: r.id,
        name: r.name,
        ...(r.color ? { color: r.color } : {}),
        position: r.position,
      })),
    };
  };

  app.get("/api/vaults/:vault/members", async (c) => {
    const vault = await known(c, "members.manage");
    return c.json({
      members: store.accounts.listMembers(vault).map((m) => describeMember(vault, m.accountId)),
    });
  });

  app.put("/api/vaults/:vault/members/:accountId", async (c) => {
    const vault = await known(c, "members.manage");
    const accountId = c.req.param("accountId");
    const { position } = await readJson(c, positionBody);
    const account = store.accounts.require(accountId);
    if (account.disabled)
      throw new AppError("invalid_request", undefined, { reason: "account is disabled" });
    const current = store.accounts.getMember(vault, accountId);
    if ((position === "admin" || current?.position === "admin") && !mayTouchAdmins(c, vault))
      throw new AppError("forbidden");
    store.joinVault(vault, accountId, position);
    auth.access.invalidate();
    auditCall(auth, c, "vault.member_set", {
      vaultId: vault,
      targetType: "account",
      targetId: accountId,
      detail: { position },
    });
    return c.json(describeMember(vault, accountId));
  });

  app.delete("/api/vaults/:vault/members/:accountId", async (c) => {
    const vault = await known(c, "members.manage");
    const accountId = c.req.param("accountId");
    const current = store.accounts.getMember(vault, accountId);
    if (!current) throw new AppError("not_found");
    if (current.position === "admin" && !mayTouchAdmins(c, vault)) throw new AppError("forbidden");
    store.tx(() => {
      store.accounts.removeMember(vault, accountId);
      store.roles.deleteAccountOverrides(vault, accountId);
    });
    auth.access.invalidate();
    auditCall(auth, c, "vault.member_removed", {
      vaultId: vault,
      targetType: "account",
      targetId: accountId,
    });
    return c.body(null, 204);
  });

  const listPermissions = (vault: string) => {
    const overrides = store.roles.vaultOverrides(vault);
    return {
      roles: store.roles.list().map((r) => ({
        id: r.id,
        name: r.name,
        ...(r.color ? { color: r.color } : {}),
        position: r.position,
      })),
      /** Names of the people the overrides are about, so a screen needs no user list. */
      people: [
        ...new Set(overrides.filter((o) => o.subjectType === "account").map((o) => o.subjectId)),
      ].flatMap((id) => {
        const a = store.accounts.get(id);
        return a ? [{ id: a.id, username: a.username, displayName: a.displayName }] : [];
      }),
      overrides: overrides.map(describeOverride),
    };
  };

  /**
   * People who could be added to the vault or given a personal override, found by name. Vault
   * administrators need no `users.manage` for this; only the matching accounts' names come back.
   */
  app.get("/api/vaults/:vault/people", async (c) => {
    const vault = c.req.param("vault")!;
    const access = accessOf(c);
    if (!access.can("members.manage", vaultScope(vault)))
      access.requireVault("permissions.manage", vault);
    await vaults.assertVault(vault);
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const found = store.accounts
      .list()
      .filter((a) => !a.disabled)
      .filter((a) => q === "" || `${a.username}\n${a.displayName}`.toLowerCase().includes(q))
      .slice(0, 20);
    return c.json({
      people: found.map((a) => ({
        id: a.id,
        username: a.username,
        displayName: a.displayName,
        member: store.accounts.getMember(vault, a.id) !== undefined,
      })),
    });
  });

  /**
   * What a role (as an ordinary member) or a person can do in the vault or one of its folders:
   * the "view as" preview. It reads the same overrides every request does.
   */
  app.get("/api/vaults/:vault/permissions/preview", async (c) => {
    const vault = await known(c, "permissions.manage");
    const roleId = c.req.query("roleId");
    const accountId = c.req.query("accountId");
    if ((roleId === undefined) === (accountId === undefined)) throw new AppError("invalid_request");
    const folder = folderOf(c.req.query("folder") || undefined);
    const scope = folder === undefined ? vaultScope(vault) : folderScope(vault, folder);
    const subject: PermissionSubject =
      roleId !== undefined
        ? {
            id: `preview:${store.roles.require(roleId).id}`,
            serverAdmin: false,
            roleIds: [roleId],
            vaults: new Map([[vault, c.req.query("position") === "admin" ? "admin" : "member"]]),
          }
        : (() => {
            const account = store.accounts.require(accountId!);
            return {
              id: account.id,
              serverAdmin: account.serverAdmin,
              roleIds: store.roles.rolesOf(account.id).map((r) => r.id),
              vaults: new Map(
                store.accounts.listMemberships(account.id).map((m) => [m.vaultId, m.position]),
              ),
            };
          })();
    const permissions = namesOf(resolvePermissions(subject, scope, accessOf(c).dataFor(vault)));
    return c.json({ permissions });
  });

  /**
   * The vault's people with their role labels, so author badges, cursors and the activity feed
   * can show a role's colour next to a name. Anyone who can see the vault may read it.
   */
  app.get("/api/vaults/:vault/roster", async (c) => {
    const vault = c.req.param("vault")!;
    accessOf(c).require("vault.view", vaultScope(vault));
    await vaults.assertVault(vault);
    return c.json({
      people: store.accounts.listMembers(vault).map((m) => {
        const a = store.accounts.require(m.accountId);
        return {
          authorId: makeAuthor("human", a.displayName, { id: a.username }).id,
          name: a.displayName,
          position: m.position,
          roles: store.roles.rolesOf(a.id).map((r) => ({
            id: r.id,
            name: r.name,
            ...(r.color ? { color: r.color } : {}),
            position: r.position,
          })),
        };
      }),
    });
  });

  app.get("/api/vaults/:vault/permissions", async (c) => {
    const vault = await known(c, "permissions.manage");
    return c.json(listPermissions(vault));
  });

  app.put("/api/vaults/:vault/permissions", async (c) => {
    const vault = await known(c, "permissions.manage");
    const body = await readJson(c, putBody);
    const folder = folderOf(body.folder);
    const limit = folder === undefined ? VAULT_MASK : FOLDER_MASK;
    const names = (list: string[], what: string) => {
      const unknown = list.filter((n) => !isPermissionName(n));
      if (unknown.length > 0)
        throw new AppError("invalid_request", undefined, {
          issues: [{ path: what, message: `unknown permission ${unknown[0]}` }],
        });
      return onlyWithin(list as never, limit, what);
    };
    const allow = names(body.allow, "allow");
    const deny = names(body.deny, "deny");
    const scope = folder === undefined ? vaultScope(vault) : folderScope(vault, folder);
    if (body.subjectType === "role") store.roles.require(body.subjectId);
    else store.accounts.require(body.subjectId);
    const target = {
      scope: folder === undefined ? "vault" : "folder",
      vaultId: vault,
      ...(folder === undefined ? {} : { folder }),
      subjectType: body.subjectType,
      subjectId: body.subjectId,
    } as const;
    // Nobody can hand out, or lift a denial of, more than they hold themselves here.
    const before = store.roles.getOverride(target) ?? { allow: 0, deny: 0 };
    if (!accessOf(c).mayChange(before, { allow, deny }, scope)) throw new AppError("forbidden");
    if (allow === 0 && deny === 0) store.roles.deleteOverride(target);
    else store.roles.setOverride(target, { allow, deny });
    auth.access.invalidate();
    auditCall(auth, c, "vault.permission_set", {
      vaultId: vault,
      targetType: body.subjectType,
      targetId: body.subjectId,
      detail: { folder: folder ?? null, allow: namesOf(allow), deny: namesOf(deny) },
    });
    return c.json(listPermissions(vault));
  });

  app.delete("/api/vaults/:vault/permissions", async (c) => {
    const vault = await known(c, "permissions.manage");
    const subjectType = z.enum(["role", "account"]).safeParse(c.req.query("subjectType"));
    const subjectId = c.req.query("subjectId");
    if (!subjectType.success || !subjectId) throw new AppError("invalid_request");
    const folder = folderOf(c.req.query("folder") || undefined);
    const target = {
      scope: folder === undefined ? "vault" : "folder",
      vaultId: vault,
      ...(folder === undefined ? {} : { folder }),
      subjectType: subjectType.data,
      subjectId,
    } as const;
    const before = store.roles.getOverride(target);
    const scope = folder === undefined ? vaultScope(vault) : folderScope(vault, folder);
    if (before && !accessOf(c).mayChange(before, { allow: 0, deny: 0 }, scope))
      throw new AppError("forbidden");
    const found = store.roles.deleteOverride({
      scope: folder === undefined ? "vault" : "folder",
      vaultId: vault,
      ...(folder === undefined ? {} : { folder }),
      subjectType: subjectType.data,
      subjectId,
    });
    if (!found) throw new AppError("not_found");
    auth.access.invalidate();
    auditCall(auth, c, "vault.permission_cleared", {
      vaultId: vault,
      targetType: subjectType.data,
      targetId: subjectId,
      detail: { folder: folder ?? null },
    });
    return c.body(null, 204);
  });

  /** What the caller can do, for deciding which buttons to show. */
  app.get("/api/me/permissions", (c) => {
    const access = accessOf(c);
    const vault = c.req.query("vault");
    const folder = c.req.query("folder");
    return c.json({
      server: access.names({ kind: "server" }),
      ...(vault
        ? {
            vault: access.names(
              folder === undefined ? vaultScope(vault) : folderScope(vault, folderOf(folder) ?? ""),
            ),
          }
        : {}),
    });
  });

  return app;
}
