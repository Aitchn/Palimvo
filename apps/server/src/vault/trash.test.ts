import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { VaultService } from "./service.ts";
import { tempVaults } from "./testing.ts";
import { VaultTrash } from "./trash.ts";

let vaults: VaultService;
let trash: VaultTrash;
let dir: string;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ vaults, dir, dispose } = await tempVaults());
  trash = new VaultTrash(vaults, path.join(dir, "trash", "vaults"));
});
afterEach(() => dispose());

const when = new Date("2026-10-21T12:00:05.123Z");

it("moves a vault to the trash, stops serving it, and restores it with its files", async () => {
  await vaults.createVault("notes");
  await vaults.writeFile("notes", "a/b.md", "kept");
  await vaults.readFile("notes", "a/b.md"); // the vault is cached and watched

  const removed = await trash.remove("notes", when);
  expect(removed).toEqual({
    name: "notes-20261021T120005Z",
    id: "notes",
    removedAt: "2026-10-21T12:00:05.000Z",
  });
  expect(await vaults.listVaults()).toEqual([]);
  await expect(vaults.readFile("notes", "a/b.md")).rejects.toMatchObject({
    code: "vault_not_found",
  });
  expect(await readFile(path.join(trash.dir, removed.name, "a", "b.md"), "utf8")).toBe("kept");
  expect(await trash.list()).toEqual([removed]);

  expect(await trash.restore(removed.name)).toEqual({ id: "notes" });
  expect((await vaults.readFile("notes", "a/b.md")).content).toBe("kept");
  expect(await trash.list()).toEqual([]);
});

it("refuses unknown vaults, repeated removal, and restoring over an existing vault", async () => {
  await expect(trash.remove("ghost")).rejects.toMatchObject({ code: "vault_not_found" });
  await vaults.createVault("notes");
  const removed = await trash.remove("notes", when);
  await expect(trash.remove("notes")).rejects.toMatchObject({ code: "vault_not_found" });
  await vaults.createVault("notes"); // the id is free again
  await expect(trash.restore(removed.name)).rejects.toMatchObject({ code: "already_exists" });
  await expect(trash.restore("../etc")).rejects.toMatchObject({ code: "not_found" });
  await expect(trash.restore("missing-20261021T120005Z")).rejects.toMatchObject({
    code: "not_found",
  });
});

it("keeps two removals of the same vault in the same second apart", async () => {
  await vaults.createVault("notes");
  const first = await trash.remove("notes", when);
  await vaults.createVault("notes");
  await writeFile(path.join(dir, "vaults", "notes", "second.md"), "2");
  const second = await trash.remove("notes", when);
  expect(second.name).toBe(`${first.name}-2`);
  expect((await trash.list()).map((r) => r.name).sort()).toEqual([first.name, second.name].sort());
  expect(await readdir(path.join(trash.dir, second.name))).toContain("second.md");
  await trash.restore(second.name);
  expect((await vaults.readFile("notes", "second.md")).content).toBe("2");
});
