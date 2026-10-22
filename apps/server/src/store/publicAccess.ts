import type { Db } from "./db.ts";

/** Which parts of a vault guests may read. A path of `""` makes the whole vault public. */
export class PublicAccessRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  list(vaultId: string): string[] {
    return this.db
      .all("select path from public_access where vault_id = ? order by path", vaultId)
      .map((r) => r.path as string);
  }

  /** Vault ids that have at least one public entry. */
  vaultIds(): string[] {
    return this.db
      .all("select distinct vault_id from public_access order by vault_id")
      .map((r) => r.vault_id as string);
  }

  /** Replaces the whole set in one transaction. */
  replace(vaultId: string, paths: readonly string[]): void {
    this.db.tx(() => {
      this.db.run("delete from public_access where vault_id = ?", vaultId);
      const t = this.now();
      for (const p of new Set(paths))
        this.db.run(
          "insert into public_access (vault_id, path, created_at) values (?, ?, ?)",
          vaultId,
          p,
          t,
        );
    });
  }
}
