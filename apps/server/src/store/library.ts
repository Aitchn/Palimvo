import { AppError } from "../errors.ts";
import { isUniqueViolation, type Db, type Row } from "./db.ts";

export interface LibraryPlugin {
  id: string;
  version: string;
  name: string;
  manifest: unknown;
  /** Hash of the plugin code; vaults approve a version by this hash. */
  sha256: string;
  builtin: boolean;
  uploadedBy?: string;
  uploadedAt: number;
}

export interface NewLibraryPlugin {
  id: string;
  version: string;
  name: string;
  manifest: unknown;
  sha256: string;
  builtin?: boolean;
  uploadedBy?: string;
}

const toPlugin = (r: Row): LibraryPlugin => ({
  id: r.id as string,
  version: r.version as string,
  name: r.name as string,
  manifest: JSON.parse(r.manifest as string) as unknown,
  sha256: r.sha256 as string,
  builtin: r.builtin === 1,
  ...(typeof r.uploaded_by === "string" ? { uploadedBy: r.uploaded_by } : {}),
  uploadedAt: r.uploaded_at as number,
});

/**
 * Index of the server's plugin library. The files themselves live in `library/plugins/<id>/<version>/`.
 * Versions are immutable: publishing an existing id and version again is a conflict.
 */
export class LibraryRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  add(input: NewLibraryPlugin): LibraryPlugin {
    try {
      this.db.run(
        `insert into library_plugins (id, version, name, manifest, sha256, builtin, uploaded_by, uploaded_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.version,
        input.name,
        JSON.stringify(input.manifest),
        input.sha256,
        input.builtin ? 1 : 0,
        input.uploadedBy ?? null,
        this.now(),
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError(
          "already_exists",
          409,
          `${input.id}@${input.version} is already published.`,
        );
      throw err;
    }
    return this.get(input.id, input.version)!;
  }

  get(id: string, version: string): LibraryPlugin | undefined {
    const r = this.db.get(
      "select * from library_plugins where id = ? and version = ?",
      id,
      version,
    );
    return r && toPlugin(r);
  }

  /** Every version of every plugin, newest upload first. */
  list(): LibraryPlugin[] {
    return this.db
      .all("select * from library_plugins order by uploaded_at desc, id, version")
      .map(toPlugin);
  }

  versionsOf(id: string): LibraryPlugin[] {
    return this.db
      .all("select * from library_plugins where id = ? order by uploaded_at desc, version", id)
      .map(toPlugin);
  }

  remove(id: string, version?: string): number {
    return version === undefined
      ? this.db.run("delete from library_plugins where id = ?", id).changes
      : this.db.run("delete from library_plugins where id = ? and version = ?", id, version)
          .changes;
  }
}
