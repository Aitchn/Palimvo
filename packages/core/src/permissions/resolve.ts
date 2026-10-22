import { dirname, pathKey } from "../paths.ts";
import {
  ALL_MASK,
  FOLDER_MASK,
  MEMBER_PERMISSIONS,
  SERVER_MASK,
  VAULT_ADMIN_PERMISSIONS,
  VAULT_ADMIN_PROTECTED,
  VAULT_MASK,
  type PermissionMask,
} from "./catalog.ts";

export type VaultMembership = "member" | "admin";

/** A role as the calculation needs it; `permissions` holds server-level bits only. */
export interface PermissionRole {
  id: string;
  /** Higher outranks lower. */
  position: number;
  permissions: PermissionMask;
  /** The implicit role every account has. */
  isEveryone?: boolean;
}

export interface PermissionOverride {
  scope: "server" | "vault" | "folder";
  vaultId?: string;
  /** Normalized folder path; only for `folder` scope. */
  folder?: string;
  subjectType: "role" | "account";
  subjectId: string;
  allow: PermissionMask;
  deny: PermissionMask;
}

export interface PermissionSubject {
  id: string;
  serverAdmin: boolean;
  /** Ids of the roles assigned to the person; the everyone role is implied. */
  roleIds: readonly string[];
  /** The vaults the person has joined. */
  vaults: ReadonlyMap<string, VaultMembership>;
}

/** Everything the calculation reads. Build it once per request. */
export interface PermissionData {
  roles: readonly PermissionRole[];
  overrides: readonly PermissionOverride[];
  /** What each vault shows to people who are not members (guests), by vault id. */
  publicPermissions?: ReadonlyMap<string, PermissionMask>;
}

/** A server-wide check, a whole vault, or a folder of a vault ("" is the vault root). */
export type PermissionScope =
  | { kind: "server" }
  | { kind: "vault"; vaultId: string }
  | { kind: "folder"; vaultId: string; folder: string };

export const serverScope: PermissionScope = { kind: "server" };
export const vaultScope = (vaultId: string): PermissionScope => ({ kind: "vault", vaultId });
export const folderScope = (vaultId: string, folder: string): PermissionScope => ({
  kind: "folder",
  vaultId,
  folder,
});
/** The scope of a file: the folder that holds it. */
export const fileScope = (vaultId: string, filePath: string): PermissionScope =>
  folderScope(vaultId, dirname(filePath));

/** Role ids that apply to the person, including the everyone role. */
function effectiveRoles(
  user: PermissionSubject,
  roles: readonly PermissionRole[],
): PermissionRole[] {
  const assigned = new Set(user.roleIds);
  return roles.filter((r) => r.isEveryone === true || assigned.has(r.id));
}

/**
 * One layer of overrides: first every role's deny, then every role's allow, then the person's
 * deny, then the person's allow. Later steps win, so a personal override beats any role.
 * Inside one row a deny beats an allow of the same permission.
 */
function applyOverrides(
  mask: PermissionMask,
  layer: readonly PermissionOverride[],
  user: PermissionSubject,
  roleIds: ReadonlySet<string>,
  limit: PermissionMask,
): PermissionMask {
  let roleDeny = 0;
  let roleAllow = 0;
  let personDeny = 0;
  let personAllow = 0;
  for (const o of layer) {
    const deny = o.deny & limit;
    const allow = o.allow & limit & ~deny;
    if (o.subjectType === "role" && roleIds.has(o.subjectId)) {
      roleDeny |= deny;
      roleAllow |= allow;
    } else if (o.subjectType === "account" && o.subjectId === user.id) {
      personDeny |= deny;
      personAllow |= allow;
    }
  }
  return (((mask & ~roleDeny) | roleAllow) & ~personDeny) | personAllow;
}

/** `a/b/c` → `["a", "a/b", "a/b/c"]`, root-first; "" → []. */
function folderChain(folder: string): string[] {
  const parts = folder.split("/").filter((p) => p !== "");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** The permissions a person holds that are not tied to a vault. */
export function resolveServerPermissions(
  user: PermissionSubject | null,
  data: PermissionData,
): PermissionMask {
  if (!user) return 0;
  if (user.serverAdmin) return ALL_MASK;
  const roles = effectiveRoles(user, data.roles);
  let mask = 0;
  for (const r of roles) mask |= r.permissions & SERVER_MASK;
  const layer = data.overrides.filter((o) => o.scope === "server");
  return applyOverrides(mask, layer, user, new Set(roles.map((r) => r.id)), SERVER_MASK);
}

/**
 * The permissions of `user` (null for a guest who is not signed in) in `scope`, in the order of
 * the design (§12.3):
 *
 * 1. A server administrator holds everything.
 * 2. Server level: the union of the permissions of all the person's roles, then server overrides.
 * 3. Vault level: a person who has not joined only gets what the vault shows the public.
 *    A member gets the member set, a vault administrator all vault permissions; then the vault's
 *    role overrides and the person's own overrides.
 * 4. Folder level: overrides of each folder from the top down, so the nearest folder wins. Only
 *    write-type permissions can change here.
 *
 * The result always contains the server-level bits, whatever the scope. Narrow it with
 * `intersect` for tokens, the assistant and plugins.
 */
export function resolvePermissions(
  user: PermissionSubject | null,
  scope: PermissionScope,
  data: PermissionData,
): PermissionMask {
  const server = resolveServerPermissions(user, data);
  if (scope.kind === "server") return server;
  if (user?.serverAdmin) return ALL_MASK;

  const publicMask = (data.publicPermissions?.get(scope.vaultId) ?? 0) & VAULT_MASK;
  const membership = user?.vaults.get(scope.vaultId);
  if (!user || !membership) return server | publicMask;

  const roleIds = new Set(effectiveRoles(user, data.roles).map((r) => r.id));
  const inVault = data.overrides.filter((o) => o.vaultId === scope.vaultId);
  const protectedBits = membership === "admin" ? VAULT_ADMIN_PROTECTED : 0;

  let vault = membership === "admin" ? VAULT_ADMIN_PERMISSIONS : MEMBER_PERMISSIONS;
  vault = applyOverrides(
    vault,
    inVault.filter((o) => o.scope === "vault"),
    user,
    roleIds,
    VAULT_MASK,
  );

  if (scope.kind === "folder") {
    const folders = inVault.filter((o) => o.scope === "folder" && o.folder !== undefined);
    for (const path of folderChain(scope.folder)) {
      const key = pathKey(path);
      const layer = folders.filter((o) => pathKey(o.folder!) === key);
      vault = applyOverrides(vault, layer, user, roleIds, FOLDER_MASK);
    }
  }
  return server | vault | protectedBits;
}
