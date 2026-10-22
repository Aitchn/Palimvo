import { isInside } from "../paths.ts";
import { maskOf, type PermissionMask } from "./catalog.ts";
import type { PermissionScope } from "./resolve.ts";

/** What an MCP token may do, from its access level (the `access` column of `api_tokens`). */
export type TokenAccess = "read" | "write" | "propose";

const READ = maskOf(["vault.view", "note.read", "history.view"]);

/**
 * The most each access level can ever do. Tokens never carry administration, restore, review or
 * plugin permissions, whatever their creator holds.
 */
export const TOKEN_ACCESS_PERMISSIONS: Readonly<Record<TokenAccess, PermissionMask>> = {
  read: READ,
  write: READ | maskOf(["note.write", "note.delete", "file.upload", "proposal.create"]),
  propose: READ | maskOf(["proposal.create"]),
};

export interface TokenScope {
  access: TokenAccess;
  /** Undefined means every vault the creator can reach. */
  vaultId?: string | undefined;
  /** Empty or undefined means the whole vault. */
  folders?: readonly string[] | undefined;
}

/**
 * Something that narrows a person's permissions: a token, a plain mask (an assistant policy or
 * a plugin's declared permissions), or a mask limited to some vaults.
 */
export type PermissionLimit = PermissionMask | { token: TokenScope; scope: PermissionScope };

function limitMask(limit: PermissionLimit): PermissionMask {
  if (typeof limit === "number") return limit;
  const { token, scope } = limit;
  const mask = TOKEN_ACCESS_PERMISSIONS[token.access];
  if (scope.kind === "server") return 0;
  if (token.vaultId !== undefined && token.vaultId !== scope.vaultId) return 0;
  const folders = token.folders ?? [];
  if (scope.kind === "folder" && folders.length > 0) {
    if (!folders.some((f) => isInside(scope.folder, f))) return 0;
  }
  return mask;
}

/**
 * The permissions that survive every limit: what the person holds, narrowed by each token scope,
 * assistant policy or plugin permission set. Pass the scope that `user` was resolved for.
 */
export function intersect(user: PermissionMask, ...limits: PermissionLimit[]): PermissionMask {
  let mask = user;
  for (const limit of limits) mask &= limitMask(limit);
  return mask;
}
