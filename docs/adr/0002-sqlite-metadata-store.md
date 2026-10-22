# 0002. SQLite metadata store with node:sqlite

- Status: accepted
- Date: 2026-10-22

## Context

The earlier project kept server-level data (accounts, sessions, tokens, OAuth, audit trail) in
JSON files that were rewritten whole. That is fragile under concurrent writes and has no
transactions. ADR 0001 (D2) chose SQLite through the `node:sqlite` module that ships with Node,
pending validation. The S1 spike verified it on Linux, Windows and macOS with Node 24 and 26:
WAL, transactions, online backup, FTS5, and recovery after `kill -9` all work, and a Windows run
with 200 connections writing at once showed `SQLITE_BUSY`. `node:sqlite` is marked "release
candidate" in Node 24 and 26 and no longer prints an experimental warning.

## Decision

Server-level metadata lives in one SQLite file, `<data dir>/palimvo.db`, accessed only through
`apps/server/src/store/db.ts`. Vault content stays as plain files and git and is never stored in
the database.

The wrapper enforces the rules from the spike:

1. One write connection, on the main thread. Reads use the same connection. A future background
   reader must open its own `readOnly` connection; nothing else may write.
2. Open order: `new DatabaseSync(file, { timeout: 5000 })`, then `journal_mode = wal`,
   `synchronous = normal`, `foreign_keys = on`. The busy timeout comes first because switching to
   WAL needs a lock.
3. Writes go through `Db.tx(fn)`, which runs `BEGIN IMMEDIATE` and rolls back if `fn` throws.
   Nested calls use savepoints. `fn` must be synchronous so no other request can run in the
   middle of a transaction on the shared connection.
4. Backups use SQLite's online `backup()`, are written to a temporary name, checked with
   `PRAGMA integrity_check`, renamed into place and hashed (SHA-256).
5. `PRAGMA wal_checkpoint(truncate)` runs hourly and on close.
6. The schema version is `PRAGMA user_version`. Migrations are an ordered list of SQL scripts,
   each applied in a transaction together with its version bump. A database whose version is
   newer than the build refuses to open (`schema_too_new`). ESLint forbids importing
   `node:sqlite` anywhere else, and a test checks the source tree as well.
7. For the full-text index planned for 0.2: FTS5 `trigram` cannot match queries shorter than three
   characters, so shorter queries (such as two-character Chinese words) must fall back to `LIKE`
   or the in-memory index.
8. Database integration tests do not open many parallel connections, because Windows file locking
   is slow with them.

Other conventions: timestamps are integer milliseconds since the epoch; tables are `STRICT`;
secrets (passwords, session ids, token values) are stored only as hashes computed by the caller;
permission bits are plain integers (the bit assignments belong to the permission model, T51);
tables whose rows point at either a role or an account clean up with triggers.

The first migration also creates `vault_members`, which records whether an account is an
administrator or an ordinary member of a vault. The permission model needs it and no other table
holds it.

## Consequences

- One file to back up, with transactions and constraints instead of whole-file rewrites.
- Supported Node versions are those where `node:sqlite` is stable enough: the minimum is Node 24.
- The API may still change while `node:sqlite` is a release candidate; the single wrapper limits
  the blast radius, and CI runs Node 24 and 26.
- Because the server is one process with one connection, throughput is far above what the
  expected load needs (the spike measured about 18k transactions per second on one connection).

## Alternatives considered

- `better-sqlite3`: mature, but a native add-on that complicates Docker images and Windows
  installs. The spike found no need for it.
- Keep JSON files: simple, but not safe under concurrent writers.
- A client/server database: too heavy for a self-hosted single-binary product.
