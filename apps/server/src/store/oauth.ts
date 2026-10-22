import { randomUUID } from "node:crypto";
import { AppError } from "../errors.ts";
import type { Db, Row } from "./db.ts";

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  secretHash?: string;
  createdAt: number;
}

export interface OAuthGrant {
  id: string;
  clientId: string;
  accountId: string;
  scope: string;
  createdAt: number;
  revokedAt?: number;
}

export type OAuthTokenKind = "code" | "access" | "refresh";

export interface OAuthToken {
  id: string;
  grantId: string;
  kind: OAuthTokenKind;
  expiresAt: number;
  codeChallenge?: string;
  redirectUri?: string;
  usedAt?: number;
  revokedAt?: number;
  createdAt: number;
}

const opt = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const toClient = (r: Row): OAuthClient => ({
  clientId: r.client_id as string,
  clientName: r.client_name as string,
  redirectUris: JSON.parse(r.redirect_uris as string) as string[],
  ...opt("secretHash", r.secret_hash as string | null),
  createdAt: r.created_at as number,
});

const toGrant = (r: Row): OAuthGrant => ({
  id: r.id as string,
  clientId: r.client_id as string,
  accountId: r.account_id as string,
  scope: r.scope as string,
  createdAt: r.created_at as number,
  ...opt("revokedAt", r.revoked_at as number | null),
});

const toToken = (r: Row): OAuthToken => ({
  id: r.id as string,
  grantId: r.grant_id as string,
  kind: r.kind as OAuthTokenKind,
  expiresAt: r.expires_at as number,
  ...opt("codeChallenge", r.code_challenge as string | null),
  ...opt("redirectUri", r.redirect_uri as string | null),
  ...opt("usedAt", r.used_at as number | null),
  ...opt("revokedAt", r.revoked_at as number | null),
  createdAt: r.created_at as number,
});

export class OAuthRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  registerClient(input: {
    clientName: string;
    redirectUris: string[];
    secretHash?: string;
  }): OAuthClient {
    const clientId = randomUUID();
    this.db.run(
      `insert into oauth_clients (client_id, client_name, redirect_uris, secret_hash, created_at)
       values (?, ?, ?, ?, ?)`,
      clientId,
      input.clientName,
      JSON.stringify(input.redirectUris),
      input.secretHash ?? null,
      this.now(),
    );
    return this.getClient(clientId)!;
  }

  getClient(clientId: string): OAuthClient | undefined {
    const r = this.db.get("select * from oauth_clients where client_id = ?", clientId);
    return r && toClient(r);
  }

  createGrant(input: { clientId: string; accountId: string; scope?: string }): OAuthGrant {
    const id = randomUUID();
    this.db.run(
      "insert into oauth_grants (id, client_id, account_id, scope, created_at) values (?, ?, ?, ?, ?)",
      id,
      input.clientId,
      input.accountId,
      input.scope ?? "",
      this.now(),
    );
    return this.getGrant(id)!;
  }

  getGrant(id: string): OAuthGrant | undefined {
    const r = this.db.get("select * from oauth_grants where id = ?", id);
    return r && toGrant(r);
  }

  listGrantsForAccount(accountId: string): OAuthGrant[] {
    return this.db
      .all("select * from oauth_grants where account_id = ? order by created_at desc", accountId)
      .map(toGrant);
  }

  /** Revoking a grant also revokes every token issued under it. */
  revokeGrant(id: string): boolean {
    return this.db.tx(() => {
      const t = this.now();
      const changed = this.db.run(
        "update oauth_grants set revoked_at = ? where id = ? and revoked_at is null",
        t,
        id,
      ).changes;
      this.db.run(
        "update oauth_tokens set revoked_at = ? where grant_id = ? and revoked_at is null",
        t,
        id,
      );
      return changed > 0;
    });
  }

  issueToken(input: {
    grantId: string;
    kind: OAuthTokenKind;
    tokenHash: string;
    expiresAt: number;
    codeChallenge?: string;
    redirectUri?: string;
  }): OAuthToken {
    const id = randomUUID();
    this.db.run(
      `insert into oauth_tokens (id, grant_id, kind, token_hash, expires_at, code_challenge, redirect_uri, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.grantId,
      input.kind,
      input.tokenHash,
      input.expiresAt,
      input.codeChallenge ?? null,
      input.redirectUri ?? null,
      this.now(),
    );
    return toToken(this.db.get("select * from oauth_tokens where id = ?", id)!);
  }

  /** Usable means: not expired, not revoked, not already used, and its grant is not revoked. */
  getUsableToken(kind: OAuthTokenKind, tokenHash: string): OAuthToken | undefined {
    const r = this.db.get(
      `select t.* from oauth_tokens t join oauth_grants g on g.id = t.grant_id
       where t.kind = ? and t.token_hash = ? and t.expires_at > ?
         and t.revoked_at is null and t.used_at is null and g.revoked_at is null`,
      kind,
      tokenHash,
      this.now(),
    );
    return r && toToken(r);
  }

  /** Marks a one-time token (an authorization code or a rotated refresh token) as spent. */
  markUsed(id: string): boolean {
    return (
      this.db.run(
        "update oauth_tokens set used_at = ? where id = ? and used_at is null",
        this.now(),
        id,
      ).changes > 0
    );
  }

  revokeToken(id: string): void {
    this.db.run(
      "update oauth_tokens set revoked_at = ? where id = ? and revoked_at is null",
      this.now(),
      id,
    );
  }

  /** Any token of this kind with this hash, even a spent or revoked one (to spot reuse). */
  findToken(kind: OAuthTokenKind, tokenHash: string): OAuthToken | undefined {
    const r = this.db.get(
      "select * from oauth_tokens where kind = ? and token_hash = ?",
      kind,
      tokenHash,
    );
    return r && toToken(r);
  }

  /** Removes clients nobody ever authorized, so open registration cannot fill the database. */
  purgeUnusedClients(olderThan: number): number {
    return this.db.run(
      `delete from oauth_clients where created_at < ?
         and not exists (select 1 from oauth_grants g where g.client_id = oauth_clients.client_id)`,
      olderThan,
    ).changes;
  }

  clientCount(): number {
    return Number(this.db.get("select count(*) as n from oauth_clients")?.n ?? 0);
  }

  requireGrant(id: string): OAuthGrant {
    const g = this.getGrant(id);
    if (!g) throw new AppError("not_found", 404, "The grant does not exist.");
    return g;
  }

  purgeExpired(): number {
    return this.db.run("delete from oauth_tokens where expires_at <= ?", this.now()).changes;
  }
}
