import type { Db, Param, Row } from "./db.ts";

export type ActorType = "account" | "token" | "assistant" | "plugin" | "system";

export interface AuditEntry {
  id: number;
  at: number;
  actorType: ActorType;
  actorId?: string;
  actorLabel?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  vaultId?: string;
  detail?: unknown;
  ip?: string;
}

export type NewAuditEntry = Omit<AuditEntry, "id" | "at"> & { at?: number };

export interface AuditQuery {
  vaultId?: string;
  actorId?: string;
  action?: string;
  /** Only entries strictly before this time (for paging). */
  before?: number;
  limit?: number;
}

const opt = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const toEntry = (r: Row): AuditEntry => ({
  id: r.id as number,
  at: r.at as number,
  actorType: r.actor_type as ActorType,
  ...opt("actorId", r.actor_id as string | null),
  ...opt("actorLabel", r.actor_label as string | null),
  action: r.action as string,
  ...opt("targetType", r.target_type as string | null),
  ...opt("targetId", r.target_id as string | null),
  ...opt("vaultId", r.vault_id as string | null),
  ...(typeof r.detail === "string" ? { detail: JSON.parse(r.detail) as unknown } : {}),
  ...opt("ip", r.ip as string | null),
});

/** Append-only record of security-relevant events. Rows can be added and pruned, never edited. */
export class AuditRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  append(entry: NewAuditEntry): number {
    return this.db.run(
      `insert into audit_log (at, actor_type, actor_id, actor_label, action, target_type, target_id, vault_id, detail, ip)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.at ?? this.now(),
      entry.actorType,
      entry.actorId ?? null,
      entry.actorLabel ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.vaultId ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      entry.ip ?? null,
    ).lastInsertRowid;
  }

  /** Newest first. */
  query(q: AuditQuery = {}): AuditEntry[] {
    const where: string[] = [];
    const params: Param[] = [];
    if (q.vaultId !== undefined) {
      where.push("vault_id = ?");
      params.push(q.vaultId);
    }
    if (q.actorId !== undefined) {
      where.push("actor_id = ?");
      params.push(q.actorId);
    }
    if (q.action !== undefined) {
      where.push("action = ?");
      params.push(q.action);
    }
    if (q.before !== undefined) {
      where.push("at < ?");
      params.push(q.before);
    }
    params.push(Math.min(Math.max(q.limit ?? 100, 1), 1000));
    return this.db
      .all(
        `select * from audit_log ${where.length ? `where ${where.join(" and ")}` : ""}
         order by at desc, id desc limit ?`,
        ...params,
      )
      .map(toEntry);
  }

  /** Retention: removes entries older than `before`. */
  prune(before: number): number {
    return this.db.run("delete from audit_log where at < ?", before).changes;
  }
}
