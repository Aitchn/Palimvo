import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { VaultChange, VaultService } from "./service.ts";
import { tempVaults } from "./testing.ts";

let vaults: VaultService;
let root: string;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ vaults, root, dispose } = await tempVaults());
  await vaults.createVault("demo");
  await vaults.tree("demo"); // starts watching
});
afterEach(() => dispose());

const onDisk = (rel: string) => path.join(root, "demo", ...rel.split("/"));

it("reports changes made outside the app within two seconds, and the tree reflects them", async () => {
  const seen: VaultChange[] = [];
  vaults.onChange((c) => c.external && seen.push(c));
  const started = Date.now();

  await mkdir(onDisk("synced"));
  await writeFile(onDisk("synced/new.md"), "from git");
  await expect
    .poll(() => seen.some((c) => c.path === "synced/new.md" || c.path === "synced"), {
      timeout: 2000,
    })
    .toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await vaults.listFiles("demo")).toContain("synced/new.md");

  await writeFile(onDisk("Welcome.md"), "edited elsewhere");
  await expect.poll(() => seen.some((c) => c.path === "Welcome.md"), { timeout: 2000 }).toBe(true);
  expect((await vaults.readFile("demo", "Welcome.md")).content).toBe("edited elsewhere");

  await rename(onDisk("synced/new.md"), onDisk("synced/renamed.md"));
  await expect
    .poll(async () => [...(await vaults.listFiles("demo"))].includes("synced/renamed.md"), {
      timeout: 2000,
    })
    .toBe(true);

  await rm(onDisk("synced"), { recursive: true });
  await expect
    .poll(async () => (await vaults.listFiles("demo")).some((p) => p.startsWith("synced/")), {
      timeout: 2000,
    })
    .toBe(false);
});
