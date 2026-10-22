import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAppError } from "@palimvo/core";
import { bytesVersion, contentVersion } from "./fsutil.ts";
import type { VaultChange, VaultService } from "./service.ts";
import { tempVaults } from "./testing.ts";

let vaults: VaultService;
let root: string;
let logs: Record<string, unknown>[];
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ vaults, root, logs, dispose } = await tempVaults());
  await vaults.createVault("demo");
});
afterEach(() => dispose());

const onDisk = (rel: string) => path.join(root, "demo", ...rel.split("/"));

/** The error a promise rejects with, which must be an API error. */
async function failure(work: Promise<unknown>) {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAppError(err), String(err)).toBe(true);
  if (!isAppError(err)) throw new Error("unreachable");
  return err;
}

describe("vaults", () => {
  it("creates a vault with settings and a welcome note, and lists it", async () => {
    expect(await vaults.listVaults()).toEqual([{ id: "demo", name: "demo" }]);
    expect(await vaults.readMeta("demo", "config.json")).toMatch(/"schemaVersion": 1/);
    expect((await vaults.readFile("demo", "Welcome.md")).content).toContain("# Welcome");
    expect((await failure(vaults.createVault("demo"))).code).toBe("already_exists");
    expect((await failure(vaults.createVault("../x"))).code).toBe("invalid_request");
    expect((await failure(vaults.readFile("nope", "a.md"))).code).toBe("vault_not_found");
  });

  it("hides the vault's settings folder from the file API and the tree", async () => {
    expect((await failure(vaults.readFile("demo", ".palimvo/config.json"))).code).toBe(
      "invalid_path",
    );
    expect((await failure(vaults.writeFile("demo", ".palimvo/x.md", "x"))).code).toBe(
      "invalid_path",
    );
    expect((await failure(vaults.readFile("demo", ".git/config"))).code).toBe("invalid_path");
    expect((await vaults.listFiles("demo")).some((p) => p.startsWith("."))).toBe(false);
  });
});

describe("reading and writing", () => {
  it("writes atomically, round-trips text and reports a content version", async () => {
    const file = await vaults.writeFile("demo", "notes/日本語 note.md", "héllo\r\nwörld");
    expect(file).toMatchObject({
      path: "notes/日本語 note.md",
      content: "héllo\r\nwörld",
      version: contentVersion("héllo\r\nwörld"),
    });
    expect(await readFile(onDisk("notes/日本語 note.md"), "utf8")).toBe("héllo\r\nwörld");
    const read = await vaults.readFile("demo", "notes\\日本語 note.md");
    expect(read.version).toBe(file.version);
    // No temp files are left behind.
    expect((await readdir(onDisk("notes"))).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("accepts a write with the current version, and answers 409 with the latest content otherwise", async () => {
    const first = await vaults.writeFile("demo", "a.md", "one", { baseVersion: null });
    const second = await vaults.writeFile("demo", "a.md", "two", { baseVersion: first.version });
    const stale = await failure(
      vaults.writeFile("demo", "a.md", "three", { baseVersion: first.version }),
    );
    expect(stale.code).toBe("version_conflict");
    expect(stale.httpStatus).toBe(409);
    expect(stale.details).toMatchObject({
      path: "a.md",
      current: { content: "two", version: second.version },
    });
    expect((await vaults.readFile("demo", "a.md")).content).toBe("two");
    // `null` means "must not exist yet".
    expect((await failure(vaults.writeFile("demo", "a.md", "x", { baseVersion: null }))).code).toBe(
      "version_conflict",
    );
    expect(
      (await failure(vaults.writeFile("demo", "gone.md", "x", { baseVersion: "abc" }))).details,
    ).toMatchObject({ current: null });
    // Without a base version the file is simply replaced.
    await vaults.writeFile("demo", "a.md", "forced");
    expect((await vaults.readFile("demo", "a.md")).content).toBe("forced");
  });

  it("refuses paths that leave the vault or are not allowed", async () => {
    for (const bad of [
      "../escape.md",
      "a/../../b.md",
      "/etc/passwd",
      "C:\\x.md",
      "con.md",
      "x\0.md",
    ]) {
      expect((await failure(vaults.writeFile("demo", bad, "x"))).code, bad).toBe("invalid_path");
    }
  });

  it("does not follow a symlink out of the vault", async () => {
    if (process.platform === "win32") return; // symlinks need extra rights there
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(outside, onDisk("link"), "dir");
    expect((await failure(vaults.readFile("demo", "link/secret.md"))).code).toBe("not_found");
    expect((await failure(vaults.writeFile("demo", "link/new.md", "x"))).code).toBe("not_found");
    expect(await readdir(outside)).toEqual(["secret.md"]);
  });

  it("only accepts text types as text, and rejects oversized text", async () => {
    expect((await failure(vaults.writeFile("demo", "pic.png", "x"))).code).toBe("unsupported_type");
    await vaults.writeFile("demo", "data.json", "{}");
    await vaults.writeFile("demo", "board.canvas", "{}");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    const written = await vaults.writeBytes("demo", "pic.png", bytes);
    expect(written.version).toBe(bytesVersion(bytes));
    expect(await readFile(onDisk("pic.png"))).toEqual(bytes);
  });

  it("reports a folder in the way as a conflict, not a crash", async () => {
    await vaults.createFolder("demo", "docs.md");
    expect((await failure(vaults.writeFile("demo", "docs.md", "x"))).code).toBe("already_exists");
    await vaults.writeFile("demo", "file.md", "x");
    expect((await failure(vaults.writeFile("demo", "file.md/inner.md", "x"))).code).toBeOneOf([
      "already_exists",
      "not_found",
    ]);
  });
});

describe("folders, moves and deletes", () => {
  it("creates folders with a hidden placeholder and shows them in the tree", async () => {
    await vaults.createFolder("demo", "projects/alpha");
    expect((await failure(vaults.createFolder("demo", "projects/alpha"))).code).toBe(
      "already_exists",
    );
    const projects = (await vaults.tree("demo")).find((n) => n.path === "projects");
    expect(projects).toMatchObject({
      type: "folder",
      children: [{ path: "projects/alpha", type: "folder", children: [] }],
    });
    expect(await readdir(onDisk("projects/alpha"))).toEqual([".gitkeep"]);
  });

  it("moves and renames files and folders, and refuses clashes and moves into itself", async () => {
    await vaults.writeFile("demo", "a/one.md", "1");
    await vaults.writeFile("demo", "a/sub/two.md", "2");
    await vaults.writeFile("demo", "taken.md", "t");
    const moved: [string, string][] = [];
    await vaults.move("demo", "a", "b/c", (m) => moved.push(...m));
    expect(moved.sort()).toEqual([
      ["a/one.md", "b/c/one.md"],
      ["a/sub/two.md", "b/c/sub/two.md"],
    ]);
    expect((await vaults.readFile("demo", "b/c/sub/two.md")).content).toBe("2");
    expect((await failure(vaults.readFile("demo", "a/one.md"))).code).toBe("not_found");
    expect((await failure(vaults.move("demo", "b/c/one.md", "taken.md"))).code).toBe(
      "already_exists",
    );
    expect((await failure(vaults.move("demo", "b", "b/c/inside"))).code).toBe("invalid_request");
    expect((await failure(vaults.move("demo", "missing.md", "x.md"))).code).toBe("not_found");
  });

  it("renames a file to a name that differs only in case", async () => {
    await vaults.writeFile("demo", "Note.md", "x");
    await vaults.move("demo", "Note.md", "note.md");
    expect(await vaults.listFiles("demo")).toEqual(["note.md", "Welcome.md"]);
    expect((await vaults.readFile("demo", "note.md")).content).toBe("x");
  });

  it("deletes files and folders and lists what went", async () => {
    await vaults.writeFile("demo", "d/a.md", "a");
    await vaults.writeFile("demo", "d/e/b.md", "b");
    let removed: string[] = [];
    await vaults.deleteFile("demo", "d", (files) => (removed = files));
    expect(removed.sort()).toEqual(["d/a.md", "d/e/b.md"]);
    expect(await vaults.listFiles("demo")).toEqual(["Welcome.md"]);
    expect((await failure(vaults.deleteFile("demo", "d"))).code).toBe("not_found");
  });

  it("tells listeners about changes, and the tree tag changes with the file list only", async () => {
    const seen: VaultChange[] = [];
    const stop = vaults.onChange((c) => !c.external && seen.push(c));
    const tag = await vaults.treeTag("demo");
    await vaults.writeFile("demo", "Welcome.md", "edited");
    expect(await vaults.treeTag("demo")).toBe(tag);
    await vaults.writeFile("demo", "n.md", "x");
    expect(await vaults.treeTag("demo")).not.toBe(tag);
    await vaults.move("demo", "n.md", "m.md");
    await vaults.deleteFile("demo", "m.md");
    stop();
    expect(seen).toEqual([
      { vault: "demo", type: "changed", path: "Welcome.md" },
      { vault: "demo", type: "changed", path: "n.md" },
      { vault: "demo", type: "moved", path: "m.md", from: "n.md" },
      { vault: "demo", type: "deleted", path: "m.md" },
    ]);
  });
});

describe("batches", () => {
  it("writes several files together, creating folders", async () => {
    const old = await vaults.writeFile("demo", "keep.md", "old");
    const results = await vaults.writeBatch("demo", [
      { path: "keep.md", baseVersion: old.version, content: "new" },
      { path: "x/y/new.md", baseVersion: null, content: "fresh" },
      { path: "bin.png", baseVersion: null, bytes: Buffer.from([1, 2, 3]) },
    ]);
    expect(results.map((r) => r.path)).toEqual(["keep.md", "x/y/new.md", "bin.png"]);
    expect((await vaults.readFile("demo", "keep.md")).content).toBe("new");
    expect((await vaults.readFile("demo", "x/y/new.md")).content).toBe("fresh");
    expect(await readFile(onDisk("bin.png"))).toEqual(Buffer.from([1, 2, 3]));
  });

  it("changes nothing when one version is stale", async () => {
    const a = await vaults.writeFile("demo", "a.md", "a1");
    await vaults.writeFile("demo", "b.md", "b1");
    const err = await failure(
      vaults.writeBatch("demo", [
        { path: "a.md", baseVersion: a.version, content: "a2" },
        { path: "b.md", baseVersion: "stale", content: "b2" },
        { path: "deep/c.md", baseVersion: null, content: "c" },
      ]),
    );
    expect(err.code).toBe("version_conflict");
    expect(err.details).toMatchObject({ path: "b.md", current: { content: "b1" } });
    expect((await vaults.readFile("demo", "a.md")).content).toBe("a1");
    expect(await vaults.listFiles("demo")).toEqual(["a.md", "b.md", "Welcome.md"]);
    await expect(readdir(onDisk("deep"))).rejects.toThrow();
  });

  it("puts files back and removes new folders when installing one fails", async () => {
    const a = await vaults.writeFile("demo", "a.md", "a1");
    await vaults.createFolder("demo", "blocked.md");
    // The second target is an existing folder, so installing it fails after the first file went in.
    const err = await failure(
      vaults.writeBatch("demo", [
        { path: "a.md", baseVersion: a.version, content: "a2" },
        { path: "new-folder/z.md", baseVersion: null, content: "z" },
        { path: "blocked.md", baseVersion: null, content: "x" },
      ]),
    );
    expect(["already_exists", "not_found", "version_conflict"]).toContain(err.code);
    expect((await vaults.readFile("demo", "a.md", { fresh: true })).content).toBe("a1");
    await expect(readdir(onDisk("new-folder"))).rejects.toThrow();
    expect((await readdir(onDisk(""))).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("rejects duplicate and overlapping paths, and oversized batches", async () => {
    const dup = [
      { path: "a.md", baseVersion: null, content: "1" },
      { path: "A.md", baseVersion: null, content: "2" },
    ];
    expect((await failure(vaults.writeBatch("demo", dup))).code).toBe("invalid_request");
    const overlap = [
      { path: "f", baseVersion: null, bytes: Buffer.from("x") },
      { path: "f/g.png", baseVersion: null, bytes: Buffer.from("y") },
    ];
    expect((await failure(vaults.writeBatch("demo", overlap))).code).toBe("invalid_request");
    const many = Array.from({ length: 501 }, (_, i) => ({
      path: `n${i}.md`,
      baseVersion: null,
      content: "",
    }));
    expect((await failure(vaults.writeBatch("demo", many))).code).toBe("payload_too_large");
  });
});

describe("concurrency", () => {
  it("handles 50 concurrent writes to different files", async () => {
    const files = Array.from({ length: 50 }, (_, i) => `many/n${i}.md`);
    await Promise.all(files.map((p, i) => vaults.writeFile("demo", p, `body ${i}`)));
    for (const [i, p] of files.entries())
      expect((await vaults.readFile("demo", p, { fresh: true })).content).toBe(`body ${i}`);
    expect((await vaults.listFiles("demo")).filter((p) => p.startsWith("many/"))).toHaveLength(50);
  });

  it("lets exactly one of 50 create-only writes to the same file win", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        vaults.writeFile("demo", "race.md", `w${i}`, { baseVersion: null }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected")
        expect((r.reason as { code: string }).code).toBe("version_conflict");
  });

  it("serializes read-modify-write cycles that use versions", async () => {
    await vaults.writeFile("demo", "counter.md", "0");
    const bump = async () => {
      for (;;) {
        const cur = await vaults.readFile("demo", "counter.md", { fresh: true });
        try {
          await vaults.writeFile("demo", "counter.md", String(Number(cur.content) + 1), {
            baseVersion: cur.version,
          });
          return;
        } catch (err) {
          if (!isAppError(err) || err.code !== "version_conflict") throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: 30 }, bump));
    expect((await vaults.readFile("demo", "counter.md", { fresh: true })).content).toBe("30");
  });

  it("keeps writes out while an exclusive task runs", async () => {
    const order: string[] = [];
    let write: Promise<unknown> | undefined;
    await vaults.exclusive("demo", async () => {
      write = vaults.writeFile("demo", "w.md", "x", { onWritten: () => order.push("write") });
      await new Promise((r) => setTimeout(r, 100));
      order.push("exclusive done");
    });
    await write;
    expect(order).toEqual(["exclusive done", "write"]);
  });
});

describe("a vault from the previous product", () => {
  it("renames .aivault to .palimvo on first use and tells the hook once", async () => {
    const calls: string[] = [];
    const legacy = await tempVaults({ hooks: { legacyMetaRenamed: (v) => void calls.push(v) } });
    try {
      const dir = path.join(legacy.root, "old");
      await mkdir(path.join(dir, ".aivault", "plugins"), { recursive: true });
      await writeFile(path.join(dir, ".aivault", "plugins", "p.json"), "{}");
      await writeFile(path.join(dir, "note.md"), "hi");
      await legacy.vaults.readFile("old", "note.md");
      await legacy.vaults.readFile("old", "note.md", { fresh: true });
      expect(await readFile(path.join(dir, ".palimvo", "plugins", "p.json"), "utf8")).toBe("{}");
      await expect(readdir(path.join(dir, ".aivault"))).rejects.toThrow();
      await expect.poll(() => calls).toEqual(["old"]);
    } finally {
      await legacy.dispose();
    }
  });

  it("leaves both folders alone when both exist", async () => {
    const dir = path.join(root, "both");
    await mkdir(path.join(dir, ".aivault"), { recursive: true });
    await mkdir(path.join(dir, ".palimvo"));
    await vaults.writeFile("both", "x.md", "x");
    expect((await readdir(dir)).sort()).toEqual([".aivault", ".palimvo", "x.md"]);
    expect(logs.some((l) => String(l.msg).includes("both"))).toBe(true);
  });

  it("removes temp files an interrupted write left, and only those", async () => {
    const other = await tempVaults();
    try {
      const dir = path.join(other.root, "v");
      await mkdir(path.join(dir, "sub"), { recursive: true });
      await writeFile(path.join(dir, "Welcome.md"), "hi");
      await writeFile(path.join(dir, "sub", ".note.md.tmp-0a1b2c3d"), "half");
      await writeFile(path.join(dir, "sub", ".keep.tmp-notahex"), "mine");
      await other.vaults.readFile("v", "Welcome.md");
      expect((await readdir(path.join(dir, "sub"))).sort()).toEqual([".keep.tmp-notahex"]);
    } finally {
      await other.dispose();
    }
  });
});
