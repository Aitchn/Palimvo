import { randomUUID } from "node:crypto";
import { AppError } from "../errors.ts";
import type { Db, Row } from "./db.ts";

export type TokenAccess = "read" | "write" | "propose";

export interface ApiToken {
  id: string;
  accountId: string;
  name: string;
  access: TokenAccess;
  /** Null covers every vault the creator can reach. */
  vaultId?: string;
  /** Empty means the whole vault. */
  folders: string[];
  rateLimitPerMinute?: number;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface NewApiToken {
  accountId: string;
  name: string;
  /** Hash of the secret; the secret is shown once and never stored. */
  tokenHash: string;
  access: TokenAccess;
  vaultId?: string;
  folders?: string[];
  rateLimitPerMinute?: number;
  expiresAt?: number;
}

const opt = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const toToken = (r: Row): ApiToken => ({
  id: r.id as string,
  accountId: r.account_id as string,
  name: r.name as string,
  access: r.access as TokenAccess,
  ...opt("vaultId", r.vault_id as string | null),
  folders: JSON.parse(r.folders as string) as string[],
  ...opt("rateLimitPerMinute", r.rate_limit_per_minute as number | null),
  createdAt: r.created_at as number,
  ...opt("expiresAt", r.expires_at as number | null),
  ...opt("lastUsedAt", r.last_used_at as number | null),
  ...opt("revokedAt", r.revoked_at as number | null),
});

export class TokensRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  create(input: NewApiToken): ApiToken {
    const id = randomUUID();
    this.db.run(
      `insert into api_tokens (id, account_id, name, token_hash, access, vault_id, folders,
         rate_limit_per_minute, created_at, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.accountId,
      input.name,
      input.tokenHash,
      input.access,
      input.vaultId ?? null,
      JSON.stringify(input.folders ?? []),
      input.rateLimitPerMinute ?? null,
      this.now(),
      input.expiresAt ?? null,
    );
    return this.require(id);
  }

  get(id: string): ApiToken | undefined {
    const r = this.db.get("select * from api_tokens where id = ?", id);
    return r && toToken(r);
  }

  require(id: string): ApiToken {
    const t = this.get(id);
    if (!t) throw new AppError("not_found", 404, "The token does not exist.");
    return t;
  }

  /** The token if it is neither revoked nor expired. */
  getActiveByHash(tokenHash: string): ApiToken | undefined {
    const r = this.db.get("select * from api_tokens where token_hash = ?", tokenHash);
    if (!r) return undefined;
    const t = toToken(r);
    return t.revokedAt === undefined && (t.expiresAt === undefined || t.expiresAt > this.now())
      ? t
      : undefined;
  }

  listForAccount(accountId: string): ApiToken[] {
    return this.db
      .all("select * from api_tokens where account_id = ? order by created_at desc", accountId)
      .map(toToken);
  }

  listAll(): ApiToken[] {
    return this.db.all("select * from api_tokens order by created_at desc").map(toToken);
  }

  markUsed(id: string): void {
    this.db.run("update api_tokens set last_used_at = ? where id = ?", this.now(), id);
  }

  revoke(id: string): boolean {
    return (
      this.db.run(
        "update api_tokens set revoked_at = ? where id = ? and revoked_at is null",
        this.now(),
        id,
      ).changes > 0
    );
  }

  delete(id: string): boolean {
    return this.db.run("delete from api_tokens where id = ?", id).changes > 0;
  }
}
