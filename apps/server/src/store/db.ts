/**
 * The only module allowed to import `node:sqlite` (enforced by ESLint and a test). Everything else
 * in the server talks to the database through `Db` and the repositories built on it.
 *
 * The rules this file implements come from the S1 spike (docs/adr/0002-sqlite-metadata-store.md):
 * one write connection on the main thread, busy timeout before WAL, `BEGIN IMMEDIATE` for writes,
 * online backups that are verified, and a periodic WAL checkpoint.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AppError } from "../errors.ts";

export const DB_FILE = "palimvo.db";

const BUSY_TIMEOUT_MS = 5000;
const CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

/** SQLite primary result codes, see https://sqlite.org/rescode.html. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

export interface Migration {
  /** Strictly increasing from 1; stored in `PRAGMA user_version`. */
  version: number;
  name: string;
  /** Plain SQL (several statements allowed). Runs inside one transaction with the version bump. */
  sql: string;
}

export interface BackupResult {
  file: string;
  bytes: number;
  sha256: string;
}

export interface OpenOptions {
  migrations: readonly Migration[];
  /** Overrides the hourly WAL checkpoint; 0 disables the timer (tests). */
  checkpointIntervalMs?: number;
}

function errcode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { errcode?: unknown }).errcode;
  return typeof code === "number" ? code : undefined;
}

/** Extended result codes carry the primary code in their low byte. */
const primary = (code: number | undefined) => (code === undefined ? undefined : code & 0xff);

export function isUniqueViolation(err: unknown): boolean {
  const code = errcode(err);
  // SQLITE_CONSTRAINT_UNIQUE and SQLITE_CONSTRAINT_PRIMARYKEY.
  return code === 2067 || code === 1555;
}

function translate(err: unknown): unknown {
  const code = primary(errcode(err));
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED)
    return new AppError("unavailable", 503, "The database is busy; try again.");
  return err;
}

/** A thin, synchronous wrapper around one `DatabaseSync` connection. */
export class Db {
  private depth = 0;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly conn: DatabaseSync,
    readonly file: string,
  ) {}

  /** Opens (creating if needed) and migrates the database at `file`. */
  static async open(file: string, options: OpenOptions): Promise<Db> {
    if (file !== ":memory:") await mkdir(path.dirname(file), { recursive: true });
    // Rule 2: the busy timeout must be set before anything that needs a lock, including the
    // WAL switch, or two connections opening at once fail with "database is locked".
    const conn = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
    const db = new Db(conn, file);
    try {
      if (file !== ":memory:") db.exec("pragma journal_mode = wal");
      db.exec("pragma synchronous = normal");
      db.exec("pragma foreign_keys = on");
      db.migrate(options.migrations);
    } catch (err) {
      conn.close();
      throw err;
    }
    const interval = options.checkpointIntervalMs ?? CHECKPOINT_INTERVAL_MS;
    if (interval > 0 && file !== ":memory:") {
      db.timer = setInterval(() => {
        try {
          db.checkpoint();
        } catch {
          // A busy checkpoint is harmless; the next tick tries again.
        }
      }, interval);
      db.timer.unref();
    }
    return db;
  }

  get open(): boolean {
    return !this.closed;
  }

  /** Runs statements that return no rows; no parameters. */
  exec(sql: string): void {
    try {
      this.conn.exec(sql);
    } catch (err) {
      throw translate(err);
    }
  }

  /** Runs one statement and reports how many rows it changed. */
  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    try {
      const r = this.conn.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    } catch (err) {
      throw translate(err);
    }
  }

  get(sql: string, ...params: Param[]): Row | undefined {
    try {
      return this.conn.prepare(sql).get(...params) as Row | undefined;
    } catch (err) {
      throw translate(err);
    }
  }

  all(sql: string, ...params: Param[]): Row[] {
    try {
      return this.conn.prepare(sql).all(...params) as Row[];
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Runs `fn` in a write transaction (`BEGIN IMMEDIATE`, rule 3) and rolls back if it throws.
   * `fn` must be synchronous: awaiting inside would let other requests run mid-transaction on
   * the same connection. Nested calls join the outer transaction through a savepoint.
   */
  tx<T>(fn: () => T): T {
    const nested = this.depth > 0;
    const savepoint = `sp${this.depth}`;
    this.exec(nested ? `savepoint ${savepoint}` : "begin immediate");
    this.depth++;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) {
        void result.catch(() => undefined);
        throw new Error("Db.tx callbacks must be synchronous");
      }
    } catch (err) {
      this.depth--;
      this.rollback(nested, savepoint);
      throw err;
    }
    this.depth--;
    try {
      this.exec(nested ? `release ${savepoint}` : "commit");
    } catch (err) {
      this.rollback(nested, savepoint);
      throw err;
    }
    return result;
  }

  private rollback(nested: boolean, savepoint: string): void {
    try {
      this.exec(nested ? `rollback to ${savepoint}; release ${savepoint}` : "rollback");
    } catch {
      // SQLite already rolled back (e.g. after a disk error); keep the original error.
    }
  }

  get userVersion(): number {
    return Number(this.get("pragma user_version")?.user_version ?? 0);
  }

  private migrate(migrations: readonly Migration[]): void {
    migrations.forEach((m, i) => {
      if (m.version !== i + 1)
        throw new Error(`Migration ${m.name} has version ${m.version}, expected ${i + 1}`);
    });
    const latest = migrations.length;
    const current = this.userVersion;
    if (current > latest)
      throw new AppError(
        "schema_too_new",
        409,
        `The database is at schema version ${current}, but this build only knows up to ${latest}. ` +
          "It was written by a newer version of Palimvo.",
      );
    for (const m of migrations.slice(current)) {
      this.tx(() => {
        this.exec(m.sql);
        // PRAGMA does not take bound parameters; the value is a trusted integer.
        this.exec(`pragma user_version = ${m.version}`);
      });
    }
  }

  /** `PRAGMA integrity_check` as a list of problems; empty means the file is sound. */
  integrityProblems(): string[] {
    const rows = this.all("pragma integrity_check");
    const messages = rows.map((r) => String(r.integrity_check));
    return messages.length === 1 && messages[0] === "ok" ? [] : messages;
  }

  /** Rule 5: folds the write-ahead log back into the main file and truncates it. */
  checkpoint(): void {
    this.exec("pragma wal_checkpoint(truncate)");
  }

  /**
   * Rule 4: copies the live database to `dest` without stopping writers, checks the copy, and
   * returns its size and SHA-256. The copy is written to a temporary name and renamed into place
   * only if it passes `integrity_check`.
   */
  async backup(dest: string): Promise<BackupResult> {
    await mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    await rm(part, { force: true });
    try {
      await backup(this.conn, part);
      // The copy inherits WAL mode; switch it to a single self-contained file before checking it.
      const copy = new DatabaseSync(part);
      let problems: string[];
      try {
        copy.exec("pragma journal_mode = delete");
        problems = (copy.prepare("pragma integrity_check").all() as Row[]).map((r) =>
          String(r.integrity_check),
        );
      } finally {
        copy.close();
      }
      if (problems.length !== 1 || problems[0] !== "ok")
        throw new AppError("internal", 500, `Backup failed its integrity check: ${problems[0]}`);
      await rename(part, dest);
    } catch (err) {
      await Promise.all([part, `${part}-wal`, `${part}-shm`].map((f) => rm(f, { force: true })));
      throw err;
    }
    return { file: dest, bytes: (await stat(dest)).size, sha256: await sha256File(dest) };
  }

  /** Stops the checkpoint timer, checkpoints once, and closes the connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    try {
      if (this.file !== ":memory:") this.conn.exec("pragma wal_checkpoint(truncate)");
    } catch {
      // Leaving a WAL file behind is safe; SQLite replays it on the next open.
    }
    this.conn.close();
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
