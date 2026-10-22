/**
 * The permission catalog. Every permission is one bit of a plain integer so a set of
 * permissions is a number that fits in a SQLite column and in JSON.
 *
 * The bit positions are stored data (roles, overrides): never renumber or reuse one. Add new
 * permissions at the end of their group's free range and keep every bit below 31, because
 * JavaScript bitwise operators work on signed 32-bit integers.
 */
export const PERMISSIONS = {
  // Server level
  "server.manage": { bit: 0, level: "server" },
  "users.manage": { bit: 1, level: "server" },
  "roles.manage": { bit: 2, level: "server" },
  "vaults.create": { bit: 3, level: "server" },
  "assistant.use": { bit: 4, level: "server" },
  "assistant.manage": { bit: 5, level: "server" },
  "library.publish": { bit: 6, level: "server" },
  "audit.view": { bit: 7, level: "server" },
  // Vault level. `folder: true` marks the write-type permissions a folder override may change.
  "vault.view": { bit: 8, level: "vault" },
  "note.read": { bit: 9, level: "vault" },
  "note.write": { bit: 10, level: "vault", folder: true },
  "note.delete": { bit: 11, level: "vault", folder: true },
  "file.upload": { bit: 12, level: "vault", folder: true },
  "history.view": { bit: 13, level: "vault" },
  "history.restore": { bit: 14, level: "vault" },
  "proposal.create": { bit: 15, level: "vault" },
  "proposal.review": { bit: 16, level: "vault", folder: true },
  "mcp.connect": { bit: 17, level: "vault" },
  "plugin.install": { bit: 18, level: "vault" },
  "plugin.approve": { bit: 19, level: "vault" },
  "vault.settings": { bit: 20, level: "vault" },
  "members.manage": { bit: 21, level: "vault" },
  "permissions.manage": { bit: 22, level: "vault" },
  "public.manage": { bit: 23, level: "vault" },
} as const satisfies Record<string, { bit: number; level: "server" | "vault"; folder?: true }>;

export type PermissionName = keyof typeof PERMISSIONS;

/** Where a permission is granted: the whole server, a vault, or (write types only) a folder. */
export type PermissionLevel = "server" | "vault";

/** A set of permissions as bits. */
export type PermissionMask = number;

export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as PermissionName[];

export function isPermissionName(value: unknown): value is PermissionName {
  return typeof value === "string" && Object.hasOwn(PERMISSIONS, value);
}

export function permissionBit(name: PermissionName): PermissionMask {
  return 1 << PERMISSIONS[name].bit;
}

/** The mask of the given permissions. */
export function maskOf(names: readonly PermissionName[]): PermissionMask {
  let mask = 0;
  for (const name of names) mask |= permissionBit(name);
  return mask;
}

/** The permission names set in `mask`, in catalog order. Unknown bits are ignored. */
export function namesOf(mask: PermissionMask): PermissionName[] {
  return PERMISSION_NAMES.filter((name) => (mask & permissionBit(name)) !== 0);
}

function maskWhere(
  test: (p: { level: PermissionLevel; folder?: true }) => boolean,
): PermissionMask {
  return maskOf(PERMISSION_NAMES.filter((name) => test(PERMISSIONS[name])));
}

export const SERVER_MASK: PermissionMask = maskWhere((p) => p.level === "server");
export const VAULT_MASK: PermissionMask = maskWhere((p) => p.level === "vault");
/** The permissions a folder override can allow or deny. */
export const FOLDER_MASK: PermissionMask = maskWhere((p) => p.folder === true);
export const ALL_MASK: PermissionMask = SERVER_MASK | VAULT_MASK;

/** Whether `mask` contains every one of `names`. */
export function hasPermission(mask: PermissionMask, ...names: PermissionName[]): boolean {
  const wanted = maskOf(names);
  return (mask & wanted) === wanted;
}

/** Whether `mask` contains at least one of `names`. */
export function hasAnyPermission(mask: PermissionMask, ...names: PermissionName[]): boolean {
  return (mask & maskOf(names)) !== 0;
}

/** What a person gets from joining a vault: read, write, upload, history, proposals, AI access. */
export const MEMBER_PERMISSIONS: PermissionMask = maskOf([
  "vault.view",
  "note.read",
  "note.write",
  "note.delete",
  "file.upload",
  "history.view",
  "proposal.create",
  "mcp.connect",
]);

/** A vault administrator holds every vault-level permission of that vault. */
export const VAULT_ADMIN_PERMISSIONS: PermissionMask = VAULT_MASK;

/**
 * Permissions a vault administrator keeps whatever the overrides say, so a vault can never be
 * locked out of its own settings by a deny.
 */
export const VAULT_ADMIN_PROTECTED: PermissionMask = maskOf([
  "vault.view",
  "vault.settings",
  "members.manage",
  "permissions.manage",
]);

/**
 * The roles the setup wizard creates (§12.4). They are ordinary roles afterwards. `vaultDeny`
 * is applied as a vault-level override on each vault the person is added to.
 */
export const DEFAULT_ROLE_TEMPLATES: readonly {
  name: string;
  permissions: PermissionMask;
  vaultDeny: PermissionMask;
  everyone?: true;
}[] = [
  { name: "@everyone", permissions: 0, vaultDeny: 0, everyone: true },
  { name: "Creator", permissions: maskOf(["vaults.create"]), vaultDeny: 0 },
  { name: "AI user", permissions: maskOf(["assistant.use"]), vaultDeny: 0 },
  {
    name: "Reader",
    permissions: 0,
    vaultDeny: maskOf(["note.write", "note.delete", "file.upload"]),
  },
];
