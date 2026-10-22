// Vault file layer benchmark: `node apps/server/scripts/bench-vault.mjs [notes=10000] [--check]`.
// Generates a synthetic vault, then times the file tree and reads/writes. With --check it exits 1
// when a milestone budget (M2: reading the cached tree < 50 ms) is missed.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { bundleOptions } from "./bundle.mjs";
import { fileURLToPath } from "node:url";

const count = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 10_000);
const check = process.argv.includes("--check");
const TREE_BUDGET_MS = 50;

const dir = await mkdtemp(path.join(tmpdir(), "palimvo-bench-"));
// The sources are TypeScript with constructs Node cannot strip, so bundle them first.
const entry = path.join(dir, "entry.mjs");
await writeFile(
  entry,
  `export { createLogger } from ${JSON.stringify(fileURLToPath(new URL("../src/log.ts", import.meta.url)))};
export { VaultService } from ${JSON.stringify(fileURLToPath(new URL("../src/vault/service.ts", import.meta.url)))};`,
);
const bundled = path.join(dir, "bundle.mjs");
await build({ ...bundleOptions(bundled, entry), logLevel: "silent" });
const { createLogger, VaultService } = await import(bundled);

const root = path.join(dir, "vaults");
const logger = createLogger({ level: "error" });
const vaults = new VaultService(root, { logger });
await vaults.init();
await vaults.createVault("bench");

const folders = Math.max(1, Math.round(count / 100));
for (let f = 0; f < folders; f++)
  await mkdir(path.join(root, "bench", `folder-${f}`), { recursive: true });
const body = "# Note\n\nSome text with a [[link]] and #tag.\n".repeat(20);
for (let i = 0; i < count; i += 200) {
  await Promise.all(
    Array.from({ length: Math.min(200, count - i) }, (_, k) =>
      writeFile(
        path.join(root, "bench", `folder-${(i + k) % folders}`, `note-${i + k}.md`),
        `${body}${i + k}`,
      ),
    ),
  );
}

const time = async (label, fn) => {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(9)} ms`);
  return { ms, result };
};

console.log(`${count} notes in ${folders} folders`);
await time("first tree (walks the disk)", () => vaults.tree("bench"));
// Opening the vault also reads every note into memory in the background; wait for that.
await new Promise((resolve) => setTimeout(resolve, 100));
await vaults.idle();
const warm = await time("tree, cached", () => vaults.tree("bench"));
await time("tree tag", () => vaults.treeTag("bench"));
await time("list files, cached", () => vaults.listFiles("bench"));
await time("read one note", () => vaults.readFile("bench", "folder-1/note-1.md"));
await time("write 200 notes in parallel", () =>
  Promise.all(
    Array.from({ length: 200 }, (_, i) => vaults.writeFile("bench", `folder-0/new-${i}.md`, body)),
  ),
);
await time("move one folder", () => vaults.move("bench", "folder-2", "moved/folder-2"));

vaults.close();
await rm(dir, { recursive: true, force: true });
if (check && warm.ms > TREE_BUDGET_MS) {
  console.error(`cached tree took ${warm.ms.toFixed(1)} ms, budget is ${TREE_BUDGET_MS} ms`);
  process.exit(1);
}
