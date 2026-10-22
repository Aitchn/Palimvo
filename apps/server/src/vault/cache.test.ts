import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultService } from "./service.ts";
import { memoryLogger, tempVaults } from "./testing.ts";

let root: string;
let vaults: VaultService;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ vaults, root, dispose } = await tempVaults());
  await vaults.createVault("demo");
});

afterEach(() => dispose());

const onDisk = (rel: string) => path.join(root, "demo", ...rel.split("/"));

describe("vault cache", () => {
  it("serves repeated reads from memory and sees the app's own writes at once", async () => {
    await vaults.writeFile("demo", "a.md", "one");
    const first = await vaults.readFile("demo", "a.md");
    expect(await vaults.readFile("demo", "a.md")).toBe(first); // same object: not read again
    await vaults.writeFile("demo", "a.md", "two");
    expect((await vaults.readFile("demo", "a.md")).content).toBe("two");
    await vaults.move("demo", "a.md", "b/a.md");
    await expect(vaults.readFile("demo", "a.md")).rejects.toMatchObject({ code: "not_found" });
    expect((await vaults.readFile("demo", "b/a.md")).content).toBe("two");
    expect(await vaults.listFiles("demo")).toEqual(["b/a.md", "Welcome.md"]);
    await vaults.deleteFile("demo", "b");
    await expect(vaults.readFile("demo", "b/a.md")).rejects.toMatchObject({ code: "not_found" });
    expect(await vaults.listFiles("demo")).toEqual(["Welcome.md"]);
  });

  it("keeps the file list until it changes, and hands it out frozen", async () => {
    const tree = await vaults.tree("demo");
    expect(await vaults.tree("demo")).toBe(tree);
    expect(Object.isFrozen(tree)).toBe(true);
    await vaults.writeFile("demo", "Welcome.md", "changed"); // content only: same list
    expect(await vaults.tree("demo")).toBe(tree);
    await vaults.writeFile("demo", "new.md", "x");
    expect((await vaults.listFiles("demo")).includes("new.md")).toBe(true);
  });

  it("notices files changed, added and removed outside the app", async () => {
    await vaults.writeFile("demo", "notes/a.md", "before");
    expect((await vaults.readFile("demo", "notes/a.md")).content).toBe("before");
    expect(await vaults.listFiles("demo")).toEqual(["notes/a.md", "Welcome.md"]);

    await writeFile(onDisk("notes/a.md"), "edited elsewhere");
    await expect
      .poll(async () => (await vaults.readFile("demo", "notes/a.md")).content, { timeout: 5000 })
      .toBe("edited elsewhere");

    await mkdir(onDisk("from-sync/deep"), { recursive: true });
    await writeFile(onDisk("from-sync/deep/b.md"), "synced");
    await expect
      .poll(async () => (await vaults.listFiles("demo")).includes("from-sync/deep/b.md"), {
        timeout: 5000,
      })
      .toBe(true);
    expect((await vaults.readFile("demo", "from-sync/deep/b.md")).content).toBe("synced");
    // A file put into a folder that appeared outside the app is watched too.
    await writeFile(onDisk("from-sync/deep/b.md"), "synced again");
    await expect
      .poll(async () => (await vaults.readFile("demo", "from-sync/deep/b.md")).content, {
        timeout: 5000,
      })
      .toBe("synced again");

    await rename(onDisk("notes"), onDisk("renamed"));
    await expect
      .poll(async () => [...(await vaults.listFiles("demo"))], { timeout: 5000 })
      .toEqual(["from-sync/deep/b.md", "renamed/a.md", "Welcome.md"]);
    await expect(vaults.readFile("demo", "notes/a.md")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("always reads the disk with fresh, and never caches a file reached through a symlink", async () => {
    await vaults.writeFile("demo", "real.md", "v1");
    await vaults.readFile("demo", "real.md");
    await writeFile(onDisk("real.md"), "v2");
    expect((await vaults.readFile("demo", "real.md", { fresh: true })).content).toBe("v2");

    if (process.platform === "win32") return; // symlinks need extra rights there
    await symlink(onDisk("real.md"), onDisk("alias.md"));
    expect((await vaults.readFile("demo", "alias.md")).content).toBe("v2");
    await vaults.writeFile("demo", "real.md", "v3");
    expect((await vaults.readFile("demo", "alias.md")).content).toBe("v3");
  });

  it("serializes writes that reach one file through different symlinked folders", async () => {
    if (process.platform === "win32") return; // symlinks need extra rights there
    await mkdir(onDisk("real"));
    await symlink(onDisk("real"), onDisk("alias"), "dir");
    const results = await Promise.allSettled([
      vaults.writeFile("demo", "real/note.md", "first", { baseVersion: null }),
      vaults.writeFile("demo", "alias/note.md", "second", { baseVersion: null }),
    ]);
    // Create-only: exactly one may win, the other sees the file already there.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("can be turned off", async () => {
    const plain = new VaultService(root, {
      logger: memoryLogger().logger,
      cache: { enabled: false },
    });
    await plain.writeFile("demo", "a.md", "x");
    const first = await plain.readFile("demo", "a.md");
    expect(await plain.readFile("demo", "a.md")).not.toBe(first);
  });
});
