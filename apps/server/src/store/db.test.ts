import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db, isUniqueViolation, type Migration } from "./db.ts";

const M1: Migration = {
  version: 1,
  name: "t",
  sql: "create table t (id integer primary key, v text unique)",
};
const M2: Migration = { version: 2, name: "u", sql: "create table u (id integer primary key)" };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "palimvo-db-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const open = (migrations: Migration[] = [M1], name = "x.db") =>
  Db.open(path.join(dir, name), { migrations, checkpointIntervalMs: 0 });

describe("opening", () => {
  it("uses WAL, foreign keys and the migration version", async () => {
    const db = await open([M1, M2]);
    expect(String(db.get("pragma journal_mode")?.journal_mode)).toBe("wal");
    expect(db.get("pragma foreign_keys")?.foreign_keys).toBe(1);
    expect(db.get("pragma synchronous")?.synchronous).toBe(1); // normal
    expect(db.get("pragma busy_timeout")?.timeout).toBe(5000);
    expect(db.userVersion).toBe(2);
    db.close();
  });

  it("applies only the migrations that are missing", async () => {
    (await open([M1])).close();
    const db = await open([M1, M2]);
    expect(db.userVersion).toBe(2);
    expect(
      db.all("select name from sqlite_master where name in ('t','u') order by name"),
    ).toHaveLength(2);
    db.close();
  });

  it("rolls a failed migration back completely", async () => {
    const bad: Migration = {
      version: 2,
      name: "bad",
      sql: "create table ok (id integer); select * from nope;",
    };
    (await open([M1])).close();
    await expect(open([M1, bad])).rejects.toThrow();
    const db = await open([M1]);
    expect(db.userVersion).toBe(1);
    expect(db.get("select name from sqlite_master where name = 'ok'")).toBeUndefined();
    db.close();
  });

  it("refuses a database written by a newer build", async () => {
    (await open([M1, M2])).close();
    await expect(open([M1])).rejects.toMatchObject({ code: "schema_too_new" });
  });

  it("rejects migrations that are not numbered 1..n", async () => {
    await expect(open([{ ...M1, version: 2 }])).rejects.toThrow(/expected 1/);
  });

  it("works in memory", async () => {
    const db = await Db.open(":memory:", { migrations: [M1] });
    db.run("insert into t (v) values (?)", "a");
    expect(db.get("select count(*) as n from t")?.n).toBe(1);
    db.close();
  });
});

describe("transactions", () => {
  it("commits on success and returns the value", async () => {
    const db = await open();
    expect(db.tx(() => (db.run("insert into t (v) values ('a')"), 7))).toBe(7);
    expect(db.get("select count(*) as n from t")?.n).toBe(1);
    db.close();
  });

  it("rolls back when the callback throws", async () => {
    const db = await open();
    expect(() =>
      db.tx(() => {
        db.run("insert into t (v) values ('a')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.get("select count(*) as n from t")?.n).toBe(0);
    db.run("insert into t (v) values ('b')"); // connection is usable afterwards
    db.close();
  });

  it("starts writes with BEGIN IMMEDIATE so a second writer waits at the start", async () => {
    const a = await Db.open(path.join(dir, "x.db"), { migrations: [M1], checkpointIntervalMs: 0 });
    const b = await Db.open(path.join(dir, "x.db"), { migrations: [M1], checkpointIntervalMs: 0 });
    // While A holds the write lock inside tx, B cannot even begin.
    await expect(
      Promise.resolve().then(() =>
        a.tx(() => {
          a.run("insert into t (v) values ('a')");
          return b.tx(() => 1);
        }),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(a.get("select count(*) as n from t")?.n).toBe(0);
    a.close();
    b.close();
  }, 15000);

  it("nests with savepoints: an inner failure rolls back only the inner part", async () => {
    const db = await open();
    db.tx(() => {
      db.run("insert into t (v) values ('outer')");
      expect(() =>
        db.tx(() => {
          db.run("insert into t (v) values ('inner')");
          throw new Error("inner failed");
        }),
      ).toThrow("inner failed");
      db.tx(() => db.run("insert into t (v) values ('inner2')"));
    });
    expect(db.all("select v from t order by v").map((r) => r.v)).toEqual(["inner2", "outer"]);
    db.close();
  });

  it("rejects asynchronous callbacks and rolls back", async () => {
    const db = await open();
    expect(() =>
      db.tx((() => {
        db.run("insert into t (v) values ('a')");
        return Promise.resolve(1);
      }) as () => unknown),
    ).toThrow(/synchronous/);
    expect(db.get("select count(*) as n from t")?.n).toBe(0);
    db.close();
  });

  it("recognizes unique violations", async () => {
    const db = await open();
    db.run("insert into t (v) values ('a')");
    let caught: unknown;
    try {
      db.run("insert into t (v) values ('a')");
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    db.close();
  });

  it("interleaved async writers on one connection never hit SQLITE_BUSY", async () => {
    const db = await open();
    const writers = Array.from({ length: 50 }, async (_, w) => {
      for (let i = 0; i < 40; i++) {
        await Promise.resolve();
        db.tx(() => db.run("insert into t (v) values (?)", `${w}-${i}`));
        if (i % 8 === 0) await new Promise((r) => setImmediate(r));
      }
    });
    await expect(Promise.all(writers)).resolves.toBeDefined();
    expect(db.get("select count(*) as n from t")?.n).toBe(2000);
    expect(db.integrityProblems()).toEqual([]);
    db.close();
  });
});

describe("backup", () => {
  it("writes a verified copy while the source keeps working", async () => {
    const db = await open();
    for (let i = 0; i < 500; i++) db.run("insert into t (v) values (?)", `row-${i}`);
    const dest = path.join(dir, "backups", "copy.db");
    const writing = (async () => {
      for (let i = 0; i < 200; i++) {
        db.run("insert into t (v) values (?)", `late-${i}`);
        await new Promise((r) => setImmediate(r));
      }
    })();
    const result = await db.backup(dest);
    await writing;
    expect(result.file).toBe(dest);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(path.join(dir, "backups"))).toEqual(["copy.db"]);

    const copy = await Db.open(dest, { migrations: [M1], checkpointIntervalMs: 0 });
    expect(Number(copy.get("select count(*) as n from t")?.n)).toBeGreaterThanOrEqual(500);
    expect(copy.integrityProblems()).toEqual([]);
    copy.close();
    db.close();
  });

  it("leaves no partial file behind when the target cannot be written", async () => {
    const db = await open();
    await writeFile(path.join(dir, "blocker"), "file");
    await expect(db.backup(path.join(dir, "blocker", "copy.db"))).rejects.toThrow();
    db.close();
  });
});

describe("maintenance", () => {
  it("checkpoints the WAL on demand and on close", async () => {
    const db = await open();
    for (let i = 0; i < 100; i++) db.run("insert into t (v) values (?)", `r${i}`);
    db.checkpoint();
    expect(db.get("pragma wal_checkpoint(passive)")?.busy).toBe(0);
    db.close();
    db.close(); // idempotent
    expect(db.open).toBe(false);
  });

  it("runs the checkpoint timer", async () => {
    const db = await Db.open(path.join(dir, "t.db"), {
      migrations: [M1],
      checkpointIntervalMs: 20,
    });
    db.run("insert into t (v) values ('a')");
    await new Promise((r) => setTimeout(r, 80));
    db.close();
  });
});
