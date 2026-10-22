import { hasPermission, type PermissionMask } from "./catalog.ts";
import {
  resolveServerPermissions,
  type PermissionData,
  type PermissionRole,
  type PermissionSubject,
} from "./resolve.ts";

/** The position of the person's highest role (the everyone role counts); -Infinity if none. */
export function highestRolePosition(
  user: PermissionSubject,
  roles: readonly PermissionRole[],
): number {
  const assigned = new Set(user.roleIds);
  let highest = Number.NEGATIVE_INFINITY;
  for (const r of roles) {
    if (r.isEveryone === true || assigned.has(r.id)) highest = Math.max(highest, r.position);
  }
  return highest;
}

/**
 * Whether `actor` may edit, delete or hand out `target`: they need `roles.manage` and the role
 * must rank below their own highest role. Server administrators may manage every role.
 */
export function canManageRole(
  actor: PermissionSubject | null,
  target: Pick<PermissionRole, "position">,
  data: PermissionData,
): boolean {
  if (!actor) return false;
  if (actor.serverAdmin) return true;
  if (!hasPermission(resolveServerPermissions(actor, data), "roles.manage")) return false;
  return target.position < highestRolePosition(actor, data.roles);
}

/**
 * Whether `actor` may give `target` the server-level permissions `wanted`: they must be allowed
 * to manage the role and may only grant permissions they hold themselves.
 */
export function canSetRolePermissions(
  actor: PermissionSubject | null,
  target: Pick<PermissionRole, "position">,
  wanted: PermissionMask,
  data: PermissionData,
): boolean {
  if (!actor || !canManageRole(actor, target, data)) return false;
  if (actor.serverAdmin) return true;
  return (wanted & ~resolveServerPermissions(actor, data)) === 0;
}

/** Whether removing `removing` from `adminIds` would leave nobody in charge. */
export function wouldLeaveNoAdmin(adminIds: readonly string[], removing: string): boolean {
  return !adminIds.some((id) => id !== removing);
}
