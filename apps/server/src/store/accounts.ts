import { randomUUID } from "node:crypto";
import { AppError } from "../errors.ts";
import { isUniqueViolation, type Db, type Row } from "./db.ts";

export type VaultPosition = "admin" | "member";

export interface Account {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  serverAdmin: boolean;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewAccount {
  username: string;
  displayName?: string;
  passwordHash: string;
  serverAdmin?: boolean;
}

export interface VaultMember {
  vaultId: string;
  accountId: string;
  position: VaultPosition;
  addedAt: number;
}

const toAccount = (r: Row): Account => ({
  id: r.id as string,
  username: r.username as string,
  displayName: r.display_name as string,
  passwordHash: r.password_hash as string,
  serverAdmin: r.server_admin === 1,
  disabled: r.disabled === 1,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

const toMember = (r: Row): VaultMember => ({
  vaultId: r.vault_id as string,
  accountId: r.account_id as string,
  position: r.position as VaultPosition,
  addedAt: r.added_at as number,
});

export class AccountsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  create(input: NewAccount): Account {
    const id = randomUUID();
    const t = this.now();
    try {
      this.db.run(
        `insert into accounts (id, username, display_name, password_hash, server_admin, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.username,
        input.displayName ?? input.username,
        input.passwordHash,
        input.serverAdmin ? 1 : 0,
        t,
        t,
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError("already_exists", 409, `The name "${input.username}" is taken.`);
      throw err;
    }
    return this.require(id);
  }

  get(id: string): Account | undefined {
    const r = this.db.get("select * from accounts where id = ?", id);
    return r && toAccount(r);
  }

  require(id: string): Account {
    const a = this.get(id);
    if (!a) throw new AppError("not_found", 404, "The account does not exist.");
    return a;
  }

  /** Case-insensitive. */
  getByUsername(username: string): Account | undefined {
    const r = this.db.get("select * from accounts where username = ?", username);
    return r && toAccount(r);
  }

  list(): Account[] {
    return this.db.all("select * from accounts order by username").map(toAccount);
  }

  count(): number {
    return Number(this.db.get("select count(*) as n from accounts")?.n ?? 0);
  }

  /** Enabled server administrators; the last one must never be removed or disabled. */
  countServerAdmins(): number {
    return Number(
      this.db.get("select count(*) as n from accounts where server_admin = 1 and disabled = 0")
        ?.n ?? 0,
    );
  }

  update(
    id: string,
    patch: Partial<Pick<Account, "displayName" | "passwordHash" | "serverAdmin" | "disabled">>,
  ): Account {
    return this.db.tx(() => {
      const current = this.require(id);
      const next = { ...current, ...patch };
      const losesAdmin =
        current.serverAdmin && !current.disabled && (!next.serverAdmin || next.disabled);
      if (losesAdmin && this.countServerAdmins() <= 1)
        throw new AppError("forbidden", 403, "The last server administrator cannot be removed.");
      this.db.run(
        `update accounts set display_name = ?, password_hash = ?, server_admin = ?, disabled = ?, updated_at = ?
         where id = ?`,
        next.displayName,
        next.passwordHash,
        next.serverAdmin ? 1 : 0,
        next.disabled ? 1 : 0,
        this.now(),
        id,
      );
      return this.require(id);
    });
  }

  /** Cascades to sessions, tokens, grants, roles and vault memberships. */
  delete(id: string): void {
    this.db.tx(() => {
      const current = this.require(id);
      if (current.serverAdmin && !current.disabled && this.countServerAdmins() <= 1)
        throw new AppError("forbidden", 403, "The last server administrator cannot be removed.");
      this.db.run("delete from accounts where id = ?", id);
    });
  }

  setMember(vaultId: string, accountId: string, position: VaultPosition): VaultMember {
    this.require(accountId);
    this.db.run(
      `insert into vault_members (vault_id, account_id, position, added_at) values (?, ?, ?, ?)
       on conflict (vault_id, account_id) do update set position = excluded.position`,
      vaultId,
      accountId,
      position,
      this.now(),
    );
    return this.getMember(vaultId, accountId)!;
  }

  getMember(vaultId: string, accountId: string): VaultMember | undefined {
    const r = this.db.get(
      "select * from vault_members where vault_id = ? and account_id = ?",
      vaultId,
      accountId,
    );
    return r && toMember(r);
  }

  removeMember(vaultId: string, accountId: string): boolean {
    return (
      this.db.run(
        "delete from vault_members where vault_id = ? and account_id = ?",
        vaultId,
        accountId,
      ).changes > 0
    );
  }

  listMembers(vaultId: string): VaultMember[] {
    return this.db
      .all("select * from vault_members where vault_id = ? order by added_at", vaultId)
      .map(toMember);
  }

  listMemberships(accountId: string): VaultMember[] {
    return this.db
      .all("select * from vault_members where account_id = ? order by vault_id", accountId)
      .map(toMember);
  }

  /** Forgets everything stored about a vault that was removed for good. */
  deleteVaultData(vaultId: string): void {
    this.db.tx(() => {
      this.db.run("delete from vault_members where vault_id = ?", vaultId);
      this.db.run("delete from permission_overrides where vault_id = ?", vaultId);
      this.db.run("delete from api_tokens where vault_id = ?", vaultId);
      this.db.run("delete from public_access where vault_id = ?", vaultId);
    });
  }
}
