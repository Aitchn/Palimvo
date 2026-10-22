import type { Author } from "@palimvo/core";
import type { Db, Row } from "./db.ts";

export interface UploadLink {
  tokenHash: string;
  vaultId: string;
  path: string;
  /** The file must not exist yet when it is saved. */
  createOnly: boolean;
  author: Author;
  reason?: string;
  createdAt: number;
  expiresAt: number;
  uploadId?: string;
}

export interface NewUploadLink {
  tokenHash: string;
  vaultId: string;
  path: string;
  createOnly: boolean;
  author: Author;
  reason?: string;
  expiresAt: number;
}

const toLink = (r: Row): UploadLink => ({
  tokenHash: r.token_hash as string,
  vaultId: r.vault_id as string,
  path: r.path as string,
  createOnly: r.create_only === 1,
  author: JSON.parse(r.author as string) as Author,
  ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
  ...(typeof r.upload_id === "string" ? { uploadId: r.upload_id } : {}),
});

/** Upload links that have not been used up or expired. */
export class UploadLinksRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  create(input: NewUploadLink): void {
    this.db.run(
      `insert into upload_links (token_hash, vault_id, path, create_only, author, reason, created_at, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.tokenHash,
      input.vaultId,
      input.path,
      input.createOnly ? 1 : 0,
      JSON.stringify(input.author),
      input.reason ?? null,
      this.now(),
      input.expiresAt,
    );
  }

  /** The link, unless it has expired (expired rows are removed on the way). */
  get(tokenHash: string): UploadLink | undefined {
    const row = this.db.get("select * from upload_links where token_hash = ?", tokenHash);
    if (!row) return undefined;
    const link = toLink(row);
    if (link.expiresAt <= this.now()) {
      this.delete(tokenHash);
      return undefined;
    }
    return link;
  }

  /** How many unexpired links a vault has. */
  countForVault(vaultId: string): number {
    this.purgeExpired();
    const row = this.db.get("select count(*) as n from upload_links where vault_id = ?", vaultId);
    return (row?.n as number | undefined) ?? 0;
  }

  setUpload(tokenHash: string, uploadId: string | null): void {
    this.db.run("update upload_links set upload_id = ? where token_hash = ?", uploadId, tokenHash);
  }

  delete(tokenHash: string): void {
    this.db.run("delete from upload_links where token_hash = ?", tokenHash);
  }

  purgeExpired(): void {
    this.db.run("delete from upload_links where expires_at <= ?", this.now());
  }
}
