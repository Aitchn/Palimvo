import type { Db, Row } from "./db.ts";

export interface Session {
  /** Hash of the cookie value; the cookie itself is never stored. */
  id: string;
  accountId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent?: string;
}

const toSession = (r: Row): Session => ({
  id: r.id as string,
  accountId: r.account_id as string,
  createdAt: r.created_at as number,
  lastSeenAt: r.last_seen_at as number,
  expiresAt: r.expires_at as number,
  ...(typeof r.user_agent === "string" ? { userAgent: r.user_agent } : {}),
});

export class SessionsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  create(input: { id: string; accountId: string; expiresAt: number; userAgent?: string }): Session {
    const t = this.now();
    this.db.run(
      `insert into sessions (id, account_id, created_at, last_seen_at, expires_at, user_agent)
       values (?, ?, ?, ?, ?, ?)`,
      input.id,
      input.accountId,
      t,
      t,
      input.expiresAt,
      input.userAgent ?? null,
    );
    return this.get(input.id)!;
  }

  get(id: string): Session | undefined {
    const r = this.db.get("select * from sessions where id = ?", id);
    return r && toSession(r);
  }

  /** The session if it exists and has not expired. */
  getValid(id: string): Session | undefined {
    const s = this.get(id);
    return s && s.expiresAt > this.now() ? s : undefined;
  }

  /** Records activity and, when given, slides the expiry forward. */
  touch(id: string, expiresAt?: number): void {
    this.db.run(
      "update sessions set last_seen_at = ?, expires_at = coalesce(?, expires_at) where id = ?",
      this.now(),
      expiresAt ?? null,
      id,
    );
  }

  delete(id: string): void {
    this.db.run("delete from sessions where id = ?", id);
  }

  deleteForAccount(accountId: string, exceptId?: string): number {
    return this.db.run(
      "delete from sessions where account_id = ? and id is not ?",
      accountId,
      exceptId ?? null,
    ).changes;
  }

  listForAccount(accountId: string): Session[] {
    return this.db
      .all("select * from sessions where account_id = ? order by last_seen_at desc", accountId)
      .map(toSession);
  }

  purgeExpired(): number {
    return this.db.run("delete from sessions where expires_at <= ?", this.now()).changes;
  }
}
