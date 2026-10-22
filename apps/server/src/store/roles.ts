import { randomUUID } from "node:crypto";
import { AppError } from "../errors.ts";
import { isUniqueViolation, type Db, type Row } from "./db.ts";

export interface Role {
  id: string;
  name: string;
  color?: string;
  /** Higher outranks lower. */
  position: number;
  /** Server-level permission bits. */
  permissions: number;
  /** The implicit role every account has. */
  isEveryone: boolean;
  createdAt: number;
}

export type OverrideScope = "server" | "vault" | "folder";
export type SubjectType = "role" | "account";

export interface PermissionOverride {
  id: number;
  scope: OverrideScope;
  vaultId?: string;
  /** Normalized vault-relative folder path; only for `folder` scope. */
  folder?: string;
  subjectType: SubjectType;
  subjectId: string;
  allow: number;
  deny: number;
  updatedAt: number;
}

export interface OverrideTarget {
  scope: OverrideScope;
  vaultId?: string;
  folder?: string;
  subjectType: SubjectType;
  subjectId: string;
}

const toRole = (r: Row): Role => ({
  id: r.id as string,
  name: r.name as string,
  ...(typeof r.color === "string" ? { color: r.color } : {}),
  position: r.position as number,
  permissions: r.permissions as number,
  isEveryone: r.is_everyone === 1,
  createdAt: r.created_at as number,
});

const toOverride = (r: Row): PermissionOverride => ({
  id: r.id as number,
  scope: r.scope as OverrideScope,
  ...(typeof r.vault_id === "string" ? { vaultId: r.vault_id } : {}),
  ...(typeof r.folder === "string" ? { folder: r.folder } : {}),
  subjectType: r.subject_type as SubjectType,
  subjectId: r.subject_id as string,
  allow: r.allow as number,
  deny: r.deny as number,
  updatedAt: r.updated_at as number,
});

export class RolesRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  create(input: {
    name: string;
    color?: string;
    position: number;
    permissions?: number;
    isEveryone?: boolean;
  }): Role {
    const id = randomUUID();
    try {
      this.db.run(
        `insert into roles (id, name, color, position, permissions, is_everyone, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.name,
        input.color ?? null,
        input.position,
        input.permissions ?? 0,
        input.isEveryone ? 1 : 0,
        this.now(),
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError("already_exists", 409, "A role with that name already exists.");
      throw err;
    }
    return this.require(id);
  }

  get(id: string): Role | undefined {
    const r = this.db.get("select * from roles where id = ?", id);
    return r && toRole(r);
  }

  require(id: string): Role {
    const r = this.get(id);
    if (!r) throw new AppError("not_found", 404, "The role does not exist.");
    return r;
  }

  getEveryone(): Role | undefined {
    const r = this.db.get("select * from roles where is_everyone = 1");
    return r && toRole(r);
  }

  /** Highest position first. */
  list(): Role[] {
    return this.db.all("select * from roles order by position desc, name").map(toRole);
  }

  update(
    id: string,
    patch: Partial<Pick<Role, "name" | "position" | "permissions">> & { color?: string | null },
  ): Role {
    const current = this.require(id);
    const color = patch.color === undefined ? (current.color ?? null) : patch.color;
    try {
      this.db.run(
        "update roles set name = ?, color = ?, position = ?, permissions = ? where id = ?",
        patch.name ?? current.name,
        color,
        patch.position ?? current.position,
        patch.permissions ?? current.permissions,
        id,
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError("already_exists", 409, "A role with that name already exists.");
      throw err;
    }
    return this.require(id);
  }

  /** The implicit @everyone role cannot be deleted. */
  delete(id: string): void {
    const role = this.require(id);
    if (role.isEveryone)
      throw new AppError("forbidden", 403, "The @everyone role cannot be deleted.");
    this.db.run("delete from roles where id = ?", id);
  }

  assign(roleId: string, accountId: string): void {
    this.require(roleId);
    this.db.run(
      "insert or ignore into role_members (role_id, account_id, assigned_at) values (?, ?, ?)",
      roleId,
      accountId,
      this.now(),
    );
  }

  unassign(roleId: string, accountId: string): boolean {
    return (
      this.db.run(
        "delete from role_members where role_id = ? and account_id = ?",
        roleId,
        accountId,
      ).changes > 0
    );
  }

  /** Roles an account holds, excluding the implicit @everyone. Highest position first. */
  rolesOf(accountId: string): Role[] {
    return this.db
      .all(
        `select r.* from roles r join role_members m on m.role_id = r.id
         where m.account_id = ? order by r.position desc, r.name`,
        accountId,
      )
      .map(toRole);
  }

  memberIds(roleId: string): string[] {
    return this.db
      .all("select account_id from role_members where role_id = ? order by assigned_at", roleId)
      .map((r) => r.account_id as string);
  }

  /** Creates or replaces the allow/deny bits for one subject at one scope. */
  setOverride(target: OverrideTarget, bits: { allow: number; deny: number }): PermissionOverride {
    const vaultId = target.scope === "server" ? null : (target.vaultId ?? null);
    const folder = target.scope === "folder" ? (target.folder ?? null) : null;
    if (
      (target.scope !== "server" && vaultId === null) ||
      (target.scope === "folder" && folder === null)
    )
      throw new AppError("invalid_request", 400, `A ${target.scope} override needs its target.`);
    this.db.run(
      `insert into permission_overrides (scope, vault_id, folder, subject_type, subject_id, allow, deny, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (scope, ifnull(vault_id, ''), ifnull(folder, ''), subject_type, subject_id)
       do update set allow = excluded.allow, deny = excluded.deny, updated_at = excluded.updated_at`,
      target.scope,
      vaultId,
      folder,
      target.subjectType,
      target.subjectId,
      bits.allow,
      bits.deny,
      this.now(),
    );
    return this.getOverride(target)!;
  }

  getOverride(target: OverrideTarget): PermissionOverride | undefined {
    const r = this.db.get(
      `select * from permission_overrides
       where scope = ? and ifnull(vault_id, '') = ? and ifnull(folder, '') = ?
         and subject_type = ? and subject_id = ?`,
      target.scope,
      target.scope === "server" ? "" : (target.vaultId ?? ""),
      target.scope === "folder" ? (target.folder ?? "") : "",
      target.subjectType,
      target.subjectId,
    );
    return r && toOverride(r);
  }

  deleteOverride(target: OverrideTarget): boolean {
    const found = this.getOverride(target);
    if (!found) return false;
    this.db.run("delete from permission_overrides where id = ?", found.id);
    return true;
  }

  serverOverrides(): PermissionOverride[] {
    return this.db.all("select * from permission_overrides where scope = 'server'").map(toOverride);
  }

  /** Vault-level and folder-level overrides for one vault, folders ordered root-first. */
  vaultOverrides(vaultId: string): PermissionOverride[] {
    return this.db
      .all(
        `select * from permission_overrides where vault_id = ?
         order by case scope when 'vault' then 0 else 1 end, length(ifnull(folder, '')), folder`,
        vaultId,
      )
      .map(toOverride);
  }
}
