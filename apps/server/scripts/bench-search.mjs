// Search and link benchmark: `node apps/server/scripts/bench-search.mjs [notes=10000] [--check]`.
// Generates a synthetic vault of English, Chinese and mixed notes, then times search, backlinks and
// the link graph. With --check it exits 1 when a warm query misses its budget.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleOptions } from "./bundle.mjs";

const count = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 10_000);
const check = process.argv.includes("--check");
const SEARCH_BUDGET_MS = 100;
const GRAPH_BUDGET_MS = 1000;

const dir = await mkdtemp(path.join(tmpdir(), "palimvo-bench-"));
const entry = path.join(dir, "entry.mjs");
const src = (rel) => JSON.stringify(fileURLToPath(new URL(rel, import.meta.url)));
await writeFile(
  entry,
  `export { createLogger } from ${src("../src/log.ts")};
export { VaultService } from ${src("../src/vault/service.ts")};
export { createVaultIndexes } from ${src("../src/search/index.ts")};`,
);
const bundled = path.join(dir, "bundle.mjs");
await build({ ...bundleOptions(bundled, entry), logLevel: "silent" });
const { createLogger, VaultService, createVaultIndexes } = await import(bundled);

const root = path.join(dir, "vaults");
const vaults = new VaultService(root, { logger: createLogger({ level: "error" }) });
await vaults.init();
await vaults.createVault("bench");
const indexes = createVaultIndexes(vaults);

const folders = Math.max(1, Math.round(count / 100));
for (let f = 0; f < folders; f++)
  await mkdir(path.join(root, "bench", `folder-${f}`), { recursive: true });
const english = "The quick brown fox jumps over the lazy dog while planning the roadmap. ";
const chinese = "今天討論了專案的決策紀錄與搜尋功能，並決定使用記憶體索引。";
for (let i = 0; i < count; i += 200) {
  await Promise.all(
    Array.from({ length: Math.min(200, count - i) }, (_, k) => {
      const n = i + k;
      const body =
        `# Note ${n}\n\n` +
        `${n % 2 ? english : chinese}`.repeat(15) +
        `\nSee [[note-${(n + 1) % count}]] and [[note-${(n * 7) % count}]].\n` +
        `Unique${n} 獨特${n}\n`;
      return writeFile(path.join(root, "bench", `folder-${n % folders}`, `note-${n}.md`), body);
    }),
  );
}

const time = async (label, fn) => {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  console.log(`${label.padEnd(36)} ${ms.toFixed(1).padStart(9)} ms`);
  return { ms, result };
};
const query = (q, options = {}) =>
  indexes.search.search("bench", q, { limit: 50, offset: 0, ...options });

console.log(`${count} notes in ${folders} folders`);
await vaults.tree("bench");
// Opening the vault also reads every note into memory in the background; wait for that.
await new Promise((resolve) => setTimeout(resolve, 200));
await vaults.idle();
await time("first search (derives every file)", () => query("roadmap"));

const warm = [];
for (const [label, q] of [
  ["English word", "roadmap"],
  ["English, two words", "lazy planning"],
  ["Chinese, two characters", "決策"],
  ["Chinese, one character", "索"],
  ["Mixed", "fox 搜尋"],
  ["Rare term (one hit)", "unique4242"],
  ["No match", "zzzzqqqq"],
]) {
  const { ms, result } = await time(`search: ${label}`, () => query(q));
  warm.push(ms);
  if (q === "unique4242" && result.total !== 1) throw new Error("rare term should find one note");
}
await time("search in one folder", () => query("roadmap", { folder: "folder-3" }));
const backlinks = await time("backlinks of one note", () =>
  indexes.links.backlinks("bench", "folder-1/note-1.md"),
);
const graph = await time("link graph", () => indexes.links.graph("bench"));
console.log(`graph: ${graph.result.nodes.length} nodes, ${graph.result.edges.length} edges`);
console.log(`note-1 has ${backlinks.result.length} backlinks`);

vaults.close();
await rm(dir, { recursive: true, force: true });
const slow = Math.max(...warm);
if (check && (slow > SEARCH_BUDGET_MS || graph.ms > GRAPH_BUDGET_MS)) {
  console.error(
    `slowest search ${slow.toFixed(1)} ms (budget ${SEARCH_BUDGET_MS}), graph ${graph.ms.toFixed(1)} ms (budget ${GRAPH_BUDGET_MS})`,
  );
  process.exit(1);
}
