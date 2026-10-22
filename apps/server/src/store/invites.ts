import { randomUUID } from "node:crypto";
import type { Db, Row } from "./db.ts";
import type { VaultPosition } from "./accounts.ts";

export interface InviteVault {
  vaultId: string;
  position: VaultPosition;
}

export interface Invite {
  id: string;
  note?: string;
  roleIds: string[];
  vaults: InviteVault[];
  createdBy?: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  usedBy?: string;
}

export interface NewInvite {
  /** Hash of the secret; the secret is shown once and never stored. */
  tokenHash: string;
  createdBy?: string;
  note?: string;
  roleIds?: string[];
  vaults?: InviteVault[];
  expiresAt: number;
}

const toInvite = (r: Row): Invite => ({
  id: r.id as string,
  ...(typeof r.note === "string" ? { note: r.note } : {}),
  roleIds: JSON.parse(r.roles as string) as string[],
  vaults: JSON.parse(r.vaults as string) as InviteVault[],
  ...(typeof r.created_by === "string" ? { createdBy: r.created_by } : {}),
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
  ...(typeof r.used_at === "number" ? { usedAt: r.used_at } : {}),
  ...(typeof r.used_by === "string" ? { usedBy: r.used_by } : {}),
});

export class InvitesRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  create(input: NewInvite): Invite {
    const id = randomUUID();
    this.db.run(
      `insert into invites (id, token_hash, created_by, note, roles, vaults, created_at, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.tokenHash,
      input.createdBy ?? null,
      input.note ?? null,
      JSON.stringify(input.roleIds ?? []),
      JSON.stringify(input.vaults ?? []),
      this.now(),
      input.expiresAt,
    );
    return this.get(id)!;
  }

  get(id: string): Invite | undefined {
    const r = this.db.get("select * from invites where id = ?", id);
    return r && toInvite(r);
  }

  /** The invite if it is unused and has not expired. */
  getUsable(tokenHash: string): Invite | undefined {
    const r = this.db.get(
      "select * from invites where token_hash = ? and used_at is null and expires_at > ?",
      tokenHash,
      this.now(),
    );
    return r && toInvite(r);
  }

  /** Marks the invite used; false if someone else used it first or it expired. Call inside `Store.tx`. */
  markUsed(id: string, accountId: string): boolean {
    return (
      this.db.run(
        `update invites set used_at = ?, used_by = ?
         where id = ? and used_at is null and expires_at > ?`,
        this.now(),
        accountId,
        id,
        this.now(),
      ).changes > 0
    );
  }

  /** Newest first. */
  list(): Invite[] {
    return this.db.all("select * from invites order by created_at desc").map(toInvite);
  }

  delete(id: string): boolean {
    return this.db.run("delete from invites where id = ?", id).changes > 0;
  }

  purgeExpired(olderThanMs = 30 * 24 * 60 * 60 * 1000): number {
    return this.db.run("delete from invites where expires_at <= ?", this.now() - olderThanMs)
      .changes;
  }
}
