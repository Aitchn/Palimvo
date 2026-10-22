import { PERMISSIONS, PERMISSION_NAMES, type PermissionName } from "@palimvo/core";

export interface PermissionGroup {
  /** Translation key suffix: `permissions.groups.<id>`. */
  id: string;
  names: PermissionName[];
}

/** How the permission pages group the catalog; every permission belongs to exactly one group. */
export const GROUPS: PermissionGroup[] = [
  { id: "access", names: ["vault.view", "note.read", "mcp.connect"] },
  { id: "editing", names: ["note.write", "note.delete", "file.upload"] },
  { id: "history", names: ["history.view", "history.restore"] },
  { id: "review", names: ["proposal.create", "proposal.review"] },
  { id: "plugins", names: ["plugin.install", "plugin.approve"] },
  {
    id: "vaultAdmin",
    names: ["vault.settings", "members.manage", "permissions.manage", "public.manage"],
  },
  { id: "serverAdmin", names: ["server.manage", "users.manage", "roles.manage", "audit.view"] },
  { id: "creating", names: ["vaults.create", "library.publish"] },
  { id: "assistant", names: ["assistant.use", "assistant.manage"] },
];

const level = (name: PermissionName) => PERMISSIONS[name].level;
const isFolder = (name: PermissionName) => "folder" in PERMISSIONS[name];

/** The groups of the permissions that apply at `where`, without the empty ones. */
export function groupsFor(where: "server" | "vault" | "folder"): PermissionGroup[] {
  const applies = (name: PermissionName) =>
    where === "folder" ? isFolder(name) : level(name) === where;
  return GROUPS.map((g) => ({ ...g, names: g.names.filter(applies) })).filter(
    (g) => g.names.length > 0,
  );
}

/** Translation key for a permission's label (`.` is the key separator, so it becomes `_`). */
export const permissionKey = (name: string): string =>
  `permissions.names.${name.replace(".", "_")}`;
export const permissionHintKey = (name: string): string =>
  `permissions.hints.${name.replace(".", "_")}`;

export const ALL_PERMISSIONS: readonly PermissionName[] = PERMISSION_NAMES;
