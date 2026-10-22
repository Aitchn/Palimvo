import type { Db } from "./db.ts";

/** Server-wide settings as JSON values under string keys. */
export class SettingsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  get<T = unknown>(key: string): T | undefined {
    const r = this.db.get("select value from server_settings where key = ?", key);
    return r ? (JSON.parse(r.value as string) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db.run(
      `insert into server_settings (key, value, updated_at) values (?, ?, ?)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      this.now(),
    );
  }

  delete(key: string): boolean {
    return this.db.run("delete from server_settings where key = ?", key).changes > 0;
  }

  all(): Record<string, unknown> {
    return Object.fromEntries(
      this.db
        .all("select key, value from server_settings order by key")
        .map((r) => [r.key as string, JSON.parse(r.value as string) as unknown]),
    );
  }
}
