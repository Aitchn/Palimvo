import type { Context } from "hono";
import {
  ALL_MASK,
  AppError,
  dirname,
  folderScope,
  hasPermission,
  isInside,
  maskOf,
  namesOf,
  resolvePermissions,
  serverScope,
  vaultScope,
  type PermissionData,
  type PermissionMask,
  type PermissionName,
  type PermissionOverride,
  type PermissionRole,
  type PermissionScope,
  type PermissionSubject,
} from "@palimvo/core";
import type { Store } from "../store/index.ts";
import type { Principal } from "./principal.ts";

/** What guests get in a vault that has public content; the paths are narrowed by `PublicPolicy`. */
const PUBLIC_MASK = maskOf(["vault.view", "note.read"]);

/**
 * Turns the stored roles, memberships and overrides into permission answers (T51's
 * `resolvePermissions`) for the people making requests. One `RequestAccess` is built per request
 * and reused, so the database is read at most once per vault and request; any change to roles,
 * memberships or overrides calls `invalidate`, which also drops what running requests cached.
 */
export class AccessControl {
  private generation = 0;

  constructor(readonly store: Store) {}

  /** Call after anything that changes who may do what. */
  invalidate(): void {
    this.generation++;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  forPrincipal(principal: Principal): RequestAccess {
    return new RequestAccess(this, principal);
  }
}

const accesses = new WeakMap<Request, RequestAccess>();

/** Binds the access helper to the request; the principal middleware calls this once. */
export function attachAccess(c: Context, access: AccessControl, principal: Principal): void {
  accesses.set(c.req.raw, access.forPrincipal(principal));
}

/** The permission checks for the current request. */
export function accessOf(c: Context): RequestAccess {
  const found = accesses.get(c.req.raw);
  if (!found) throw new Error("accessOf called before the principal middleware ran");
  return found;
}

/** Permission answers for one request. */
export class RequestAccess {
  private seenGeneration: number;
  private subject: PermissionSubject | null | undefined;
  private roles: PermissionRole[] | undefined;
  private serverOverrides: PermissionOverride[] | undefined;
  private readonly vaultOverrides = new Map<string, PermissionOverride[]>();
  private readonly publicMasks = new Map<string, PermissionMask>();

  constructor(
    private readonly control: AccessControl,
    readonly principal: Principal,
  ) {
    this.seenGeneration = control.currentGeneration;
  }

  /** Setup mode: before the first account exists nothing is enforced. */
  get isOpen(): boolean {
    return this.principal.kind === "open";
  }

  get isGuest(): boolean {
    return this.principal.kind === "guest";
  }

  /** The signed-in account's id, if any. */
  get accountId(): string | undefined {
    return this.principal.kind === "account" ? this.principal.account.id : undefined;
  }

  get isServerAdmin(): boolean {
    return this.isOpen || (this.principal.kind === "account" && this.principal.account.serverAdmin);
  }

  private fresh(): void {
    if (this.seenGeneration === this.control.currentGeneration) return;
    this.seenGeneration = this.control.currentGeneration;
    this.subject = undefined;
    this.roles = undefined;
    this.serverOverrides = undefined;
    this.vaultOverrides.clear();
    this.publicMasks.clear();
  }

  /** The person as the permission calculation sees them; null for guests. */
  asSubject(): PermissionSubject | null {
    this.fresh();
    if (this.principal.kind !== "account") return null;
    if (this.subject === undefined) {
      const { store } = this.control;
      const { account } = this.principal;
      this.subject = {
        id: account.id,
        serverAdmin: account.serverAdmin,
        roleIds: store.roles.rolesOf(account.id).map((r) => r.id),
        vaults: new Map(
          store.accounts.listMemberships(account.id).map((m) => [m.vaultId, m.position]),
        ),
      };
    }
    return this.subject;
  }

  /** Roles and overrides as `resolvePermissions` reads them, limited to what `vaultId` needs. */
  dataFor(vaultId?: string): PermissionData {
    this.fresh();
    const { store } = this.control;
    this.roles ??= store.roles.list().map((r) => ({
      id: r.id,
      position: r.position,
      permissions: r.permissions,
      isEveryone: r.isEveryone,
    }));
    this.serverOverrides ??= store.roles.serverOverrides();
    let overrides = this.serverOverrides;
    const publicPermissions = new Map<string, PermissionMask>();
    if (vaultId !== undefined) {
      let inVault = this.vaultOverrides.get(vaultId);
      if (!inVault) {
        inVault = store.roles.listOverrides({ vaultId });
        this.vaultOverrides.set(vaultId, inVault);
      }
      overrides = [...overrides, ...inVault];
      let pub = this.publicMasks.get(vaultId);
      if (pub === undefined) {
        pub = store.publicAccess.list(vaultId).length > 0 ? PUBLIC_MASK : 0;
        this.publicMasks.set(vaultId, pub);
      }
      publicPermissions.set(vaultId, pub);
    }
    return { roles: this.roles, overrides, publicPermissions };
  }

  /** Every permission the caller holds in `scope`. */
  mask(scope: PermissionScope): PermissionMask {
    if (this.isOpen) return ALL_MASK;
    return resolvePermissions(
      this.asSubject(),
      scope,
      this.dataFor(scope.kind === "server" ? undefined : scope.vaultId),
    );
  }

  can(name: PermissionName, scope: PermissionScope): boolean {
    return hasPermission(this.mask(scope), name);
  }

  names(scope: PermissionScope): PermissionName[] {
    return namesOf(this.mask(scope));
  }

  /**
   * Throws unless the caller holds `name` in `scope`. A vault the caller cannot even view looks
   * like a vault that does not exist; guests are asked to sign in.
   */
  require(name: PermissionName, scope: PermissionScope): void {
    if (this.can(name, scope)) return;
    throw this.denial(scope);
  }

  /** Several permissions at once in one scope. */
  requireAll(names: readonly PermissionName[], scope: PermissionScope): void {
    for (const name of names) this.require(name, scope);
  }

  private denial(scope: PermissionScope): AppError {
    if (scope.kind !== "server" && !this.can("vault.view", scope))
      return new AppError("vault_not_found");
    return new AppError(this.isGuest ? "unauthenticated" : "forbidden");
  }

  requireServer(name: PermissionName): void {
    this.require(name, serverScope);
  }

  requireVault(name: PermissionName, vaultId: string): void {
    this.require(name, vaultScope(vaultId));
  }

  /**
   * Checks a write-type permission on a file or folder: the folder that holds it, the path itself
   * (a folder), and every folder with its own override inside it, so a delete or move of a parent
   * cannot get around a restriction further down. The vault-wide answer is not asked separately:
   * folder rules layer on top of it, so a folder may allow what the vault as a whole denies
   * ("this role may only write in design/").
   */
  requireTree(name: PermissionName, vaultId: string, path: string): void {
    const scopes = new Set<string>([dirname(path), path]);
    for (const o of this.vaultFolderOverrides(vaultId))
      if (o.folder !== undefined && isInside(o.folder, path)) scopes.add(o.folder);
    for (const folder of scopes) this.require(name, folderScope(vaultId, folder));
  }

  private vaultFolderOverrides(vaultId: string): PermissionOverride[] {
    this.dataFor(vaultId);
    return (this.vaultOverrides.get(vaultId) ?? []).filter((o) => o.scope === "folder");
  }

  /** Whether the caller may give out `wanted` in `scope`: only what they hold themselves. */
  holdsAll(wanted: PermissionMask, scope: PermissionScope): boolean {
    return (wanted & ~this.mask(scope)) === 0;
  }

  /**
   * Whether the caller may replace an override with another: everything the change newly allows
   * or stops denying must be something they hold now, so lifting a deny cannot give a right back.
   */
  mayChange(
    before: { allow: PermissionMask; deny: PermissionMask },
    after: { allow: PermissionMask; deny: PermissionMask },
    scope: PermissionScope,
  ): boolean {
    if (this.isServerAdmin) return true;
    const gained = (after.allow & ~before.allow) | (before.deny & ~after.deny);
    return this.holdsAll(gained, scope);
  }

  /** Vault ids the caller can see (open mode: all of `allVaultIds`). */
  visibleVaults(allVaultIds: readonly string[]): string[] {
    return allVaultIds.filter((id) => this.can("vault.view", vaultScope(id)));
  }
}
