import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { referencedFiles } from "./manifest.ts";
import { validateManifest } from "./validate.ts";

// The graph plugin is one plain JS file (the browser host loads only `main`); its pure parts are
// exported so they can be tested here without a browser. The drawing is covered by the e2e test.
const folder = fileURLToPath(new URL("../../../plugins/graph/", import.meta.url));

interface RawNode {
  path: string;
  title: string;
  kind: "markdown" | "canvas" | "base";
  tags?: string[];
}
interface RawEdge {
  from: string;
  to: string;
  embed: boolean;
}
interface Raw {
  nodes: RawNode[];
  edges: RawEdge[];
}
interface Model {
  count: number;
  nodes: Array<{ key: string; type: number; group: number; deg: number; label: string }>;
  index: Map<string, number>;
  edgeCount: number;
  edgeA: Int32Array;
  edgeB: Int32Array;
  edgeKind: Uint8Array;
  adjStart: Int32Array;
  adjList: Int32Array;
  degree: Int32Array;
  radius: Float32Array;
  byDegree: Int32Array;
  groups: Array<{ id: number; name: string; size: number }>;
  tagCount: number;
  x: Float64Array;
  y: Float64Array;
}
interface Simulation {
  alpha: number;
  settled: boolean;
  tick(): void;
  run(budgetMs: number, maxTicks?: number): number;
  reheat(level?: number): void;
  pin(i: number, on: boolean): void;
}
interface View {
  k: number;
  x: number;
  y: number;
}
const plugin = (await import(pathToFileURL(`${folder}main.js`).href)) as {
  buildModel(raw: Raw, options?: Record<string, unknown>): Model;
  queryMask(model: Model, query: string): Uint8Array | null;
  localSubset(
    raw: Raw,
    center: string,
    limit?: number,
  ): { nodes: RawNode[]; edges: RawEdge[]; total: number };
  createSimulation(model: Model): Simulation;
  fitView(model: Model, width: number, height: number, padding?: number): View;
  pickNode(model: Model, view: View, x: number, y: number, slack?: number): number;
  toScreen(view: View, x: number, y: number): [number, number];
  toGraph(view: View, x: number, y: number): [number, number];
  topFolders(raw: Raw): string[];
  groupColor(id: number, dark: boolean): string;
  LOCAL_LIMIT: number;
};

const note = (path: string, tags?: string[]): RawNode => ({
  path,
  title: path.replace(/^.*\//, "").replace(/\.\w+$/, ""),
  kind: "markdown",
  ...(tags ? { tags } : {}),
});
const link = (from: string, to: string, embed = false): RawEdge => ({ from, to, embed });

const sample: Raw = {
  nodes: [
    note("Home.md", ["plan"]),
    note("Projects/A.md", ["plan", "idea"]),
    note("Projects/B.md", ["idea"]),
    note("Projects/C.md"),
    { path: "Board.canvas", title: "Board", kind: "canvas" },
    note("Lonely.md"),
  ],
  edges: [
    link("Home.md", "Projects/A.md"),
    link("Projects/A.md", "Projects/B.md"),
    link("Projects/B.md", "Projects/C.md", true),
    link("Board.canvas", "Home.md"),
  ],
};

/** A reproducible random graph: `n` notes in folders, about `links` links, some hubs. */
function synthetic(n: number, links: number): Raw {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const nodes = Array.from({ length: n }, (_, i) => note(`f${i % 40}/note-${i}.md`));
  const edges: RawEdge[] = [];
  const seen = new Set<string>();
  while (edges.length < links) {
    const a = Math.floor(rand() * n);
    // Preferential-ish: half the targets come from the first 5% (hubs).
    const b = rand() < 0.5 ? Math.floor(rand() * n * 0.05) : Math.floor(rand() * n);
    if (a === b || seen.has(`${a}-${b}`)) continue;
    seen.add(`${a}-${b}`);
    edges.push(link(nodes[a]!.path, nodes[b]!.path));
  }
  return { nodes, edges };
}

describe("graph plugin manifest", () => {
  it("is valid and contributes a page and an inspector panel", () => {
    const json: unknown = JSON.parse(readFileSync(`${folder}manifest.json`, "utf8"));
    const r = validateManifest(json, { palimvoVersion: "0.1.0" });
    expect(r.ok, r.ok ? "" : JSON.stringify(r.issues)).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.contributes.views.map((v) => v.id)).toEqual(["links"]);
    expect(r.manifest.contributes.slots.map((s) => `${s.slot}/${s.id}`)).toEqual([
      "inspector/local",
    ]);
    expect(r.manifest.permissions.write).toEqual([]);
    expect(r.manifest.permissions.network).toBe(false);
    for (const file of referencedFiles(r.manifest)) {
      expect(() => readFileSync(`${folder}${file}`, "utf8"), file).not.toThrow();
    }
  });

  it("has the same strings in all three languages, and every string the code asks for", () => {
    const read = (name: string) =>
      JSON.parse(readFileSync(`${folder}locales/${name}.json`, "utf8")) as Record<string, string>;
    const en = read("en");
    const keys = Object.keys(en).sort();
    expect(Object.keys(read("zh-TW")).sort()).toEqual(keys);
    expect(Object.keys(read("zh-CN")).sort()).toEqual(keys);
    for (const name of ["en", "zh-TW", "zh-CN"]) {
      const table = read(name);
      // Placeholders must match English, or a translation would print "{count}" literally.
      for (const key of keys) {
        const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(holes(table[key]!), `${name}.${key}`).toEqual(holes(en[key]!));
      }
    }
    const source = readFileSync(`${folder}main.js`, "utf8");
    const used = new Set<string>();
    for (const m of source.matchAll(/\bt\(\s*"(\w+)"/g)) used.add(m[1]!);
    for (const m of source.matchAll(/KIND_KEY = \[([^\]]*)\]/g))
      for (const k of m[1]!.matchAll(/"(\w+)"/g)) used.add(k[1]!);
    for (const key of ["kindMarkdown", "kindCanvas", "kindBase"]) used.add(key);
    for (const key of used) expect(keys, `missing string ${key}`).toContain(key);
  });
});

describe("buildModel", () => {
  it("counts nodes and links and builds neighbor lists", () => {
    const m = plugin.buildModel(sample);
    expect(m.count).toBe(6);
    expect(m.edgeCount).toBe(4);
    const home = m.index.get("Home.md")!;
    const neighbors = [...m.adjList.slice(m.adjStart[home], m.adjStart[home! + 1])].sort();
    expect(neighbors).toEqual([m.index.get("Projects/A.md"), m.index.get("Board.canvas")].sort());
    expect(m.degree[m.index.get("Lonely.md")!]).toBe(0);
    expect(m.nodes[m.index.get("Board.canvas")!]!.type).toBe(1);
    // Best connected first.
    expect(m.byDegree[0]).toBeDefined();
    expect(m.degree[m.byDegree[0]!]).toBe(Math.max(...m.degree));
  });

  it("can leave out embeds, unlinked notes and other folders", () => {
    expect(plugin.buildModel(sample, { embeds: false }).edgeCount).toBe(3);
    const noOrphans = plugin.buildModel(sample, { orphans: false });
    expect(noOrphans.index.has("Lonely.md")).toBe(false);
    expect(noOrphans.count).toBe(5);
    const projects = plugin.buildModel(sample, { folder: "Projects" });
    expect([...projects.index.keys()].sort()).toEqual([
      "Projects/A.md",
      "Projects/B.md",
      "Projects/C.md",
    ]);
    expect(projects.edgeCount).toBe(2);
    expect(plugin.topFolders(sample)).toEqual(["Projects"]);
  });

  it("adds a node for each tag used twice or more, linked to its notes", () => {
    const m = plugin.buildModel(sample, { tags: true });
    // plan (Home, A) and idea (A, B) qualify; both tags are used by two notes.
    expect(m.tagCount).toBe(2);
    expect(m.count).toBe(8);
    expect(m.index.has("#plan")).toBe(false);
    const tagNodes = m.nodes.filter((n) => n.type === 3).map((n) => n.key);
    expect(tagNodes.sort()).toEqual(["#idea", "#plan"]);
    expect([...m.edgeKind].filter((k) => k === 2)).toHaveLength(4);
    // Tags are off unless asked for.
    expect(plugin.buildModel(sample).tagCount).toBe(0);
  });

  it("colors by folder, tag or file type, with the biggest groups first", () => {
    const byFolder = plugin.buildModel(sample, { colorBy: "folder" });
    expect(byFolder.groups.map((g) => g.name)).toEqual(["Projects"]);
    expect(byFolder.nodes[byFolder.index.get("Home.md")!]!.group).toBe(-1);
    const byTag = plugin.buildModel(sample, { colorBy: "tag" });
    expect(byTag.groups.map((g) => g.name).sort()).toEqual(["idea", "plan"]);
    const byType = plugin.buildModel(sample, { colorBy: "type" });
    expect(byType.groups[0]!.name).toBe("markdown");
    // More groups than colors: the extra ones share the last color.
    const many: Raw = {
      nodes: Array.from({ length: 20 }, (_, i) => note(`d${i}/n.md`)),
      edges: [],
    };
    const m = plugin.buildModel(many);
    expect(m.groups).toHaveLength(12);
    expect(Math.max(...m.nodes.map((n) => n.group))).toBe(12);
  });

  it("keeps the positions of nodes that were already placed", () => {
    const first = plugin.buildModel(sample);
    const previous = new Map<string, [number, number]>([["Home.md", [123, -45]]]);
    const second = plugin.buildModel(sample, { previous });
    const i = second.index.get("Home.md")!;
    expect([second.x[i], second.y[i]]).toEqual([123, -45]);
    expect(first.x[i]).not.toBe(123);
  });

  it("ignores links to files that are not shown and links from a file to itself", () => {
    const m = plugin.buildModel({
      nodes: [note("a.md"), note("b.md")],
      edges: [link("a.md", "a.md"), link("a.md", "gone.md"), link("a.md", "b.md")],
    });
    expect(m.edgeCount).toBe(1);
  });

  it("copes with an empty vault", () => {
    const m = plugin.buildModel({ nodes: [], edges: [] });
    expect(m.count).toBe(0);
    const sim = plugin.createSimulation(m);
    sim.run(5);
    expect(plugin.fitView(m, 400, 300).k).toBe(1);
  });
});

describe("queryMask", () => {
  it("matches every word in the name, path or tag", () => {
    const m = plugin.buildModel(sample, { tags: true });
    const hits = (q: string) =>
      m.nodes.filter((_, i) => plugin.queryMask(m, q)?.[i]).map((n) => n.key);
    expect(hits("proj a")).toEqual(["Projects/A.md"]);
    expect(hits("#idea")).toEqual(["#idea"]);
    expect(hits("PLAN").sort()).toEqual(["#plan"]);
    expect(plugin.queryMask(m, "   ")).toBeNull();
  });
});

describe("localSubset", () => {
  const chain: Raw = {
    nodes: ["a", "b", "c", "d", "e"].map((n) => note(`${n}.md`)),
    edges: [link("a.md", "b.md"), link("b.md", "c.md"), link("c.md", "d.md"), link("e.md", "a.md")],
  };

  it("keeps the nearest files first when there are too many", () => {
    const some = plugin.localSubset(chain, "a.md", 3);
    expect(some.total).toBe(5);
    expect(some.nodes.map((n) => n.path).sort()).toEqual(["a.md", "b.md", "e.md"]);
    expect(some.edges).toHaveLength(2);
    const all = plugin.localSubset(chain, "a.md");
    expect(all.nodes).toHaveLength(5);
  });

  it("always keeps the open file, even without links", () => {
    const only = plugin.localSubset({ nodes: [note("x.md")], edges: [] }, "x.md");
    expect(only.nodes.map((n) => n.path)).toEqual(["x.md"]);
    expect(plugin.LOCAL_LIMIT).toBeGreaterThan(50);
  });
});

describe("layout", () => {
  it("settles and keeps every position finite", () => {
    const m = plugin.buildModel(synthetic(400, 900));
    const sim = plugin.createSimulation(m);
    expect(sim.settled).toBe(false);
    while (!sim.settled) sim.tick();
    expect([...m.x, ...m.y].every(Number.isFinite)).toBe(true);
  });

  it("pulls linked notes together and pushes unlinked ones apart", () => {
    const raw: Raw = {
      nodes: [note("a.md"), note("b.md"), note("c.md")],
      edges: [link("a.md", "b.md")],
    };
    const m = plugin.buildModel(raw);
    const sim = plugin.createSimulation(m);
    while (!sim.settled) sim.tick();
    const d = (p: string, q: string) => {
      const i = m.index.get(p)!;
      const j = m.index.get(q)!;
      return Math.hypot(m.x[i]! - m.x[j]!, m.y[i]! - m.y[j]!);
    };
    expect(d("a.md", "b.md")).toBeLessThan(d("a.md", "c.md"));
  });

  it("separates notes that start on the same spot", () => {
    const m = plugin.buildModel({ nodes: [note("a.md"), note("b.md"), note("c.md")], edges: [] });
    m.x.fill(5);
    m.y.fill(5);
    const sim = plugin.createSimulation(m);
    sim.run(50, 50);
    expect(m.x[0] === m.x[1] && m.y[0] === m.y[1]).toBe(false);
    expect([...m.x, ...m.y].every(Number.isFinite)).toBe(true);
  });

  it("does not move a pinned note, and can be woken again", () => {
    const m = plugin.buildModel(synthetic(60, 120));
    const sim = plugin.createSimulation(m);
    sim.pin(3, true);
    const at = [m.x[3], m.y[3]];
    sim.run(50, 30);
    expect([m.x[3], m.y[3]]).toEqual(at);
    while (!sim.settled) sim.tick();
    sim.reheat(0.5);
    expect(sim.settled).toBe(false);
  });

  it("is deterministic", () => {
    const run = () => {
      const m = plugin.buildModel(synthetic(200, 400));
      const sim = plugin.createSimulation(m);
      for (let i = 0; i < 30; i++) sim.tick();
      return Array.from(m.x.slice(0, 5));
    };
    expect(run()).toEqual(run());
  });

  it("takes about as long per step as a smooth animation allows for 10,000 notes", () => {
    const m = plugin.buildModel(synthetic(10_000, 25_000));
    const sim = plugin.createSimulation(m);
    sim.tick(); // warm up
    const start = performance.now();
    const steps = 8;
    for (let i = 0; i < steps; i++) sim.tick();
    const perStep = (performance.now() - start) / steps;
    // Generous bound for slow CI machines; a laptop needs about 10 ms.
    expect(perStep).toBeLessThan(120);
    expect([...m.x.slice(0, 100)].every(Number.isFinite)).toBe(true);
  }, 30_000);
});

describe("view", () => {
  it("converts between screen and graph space", () => {
    const view = { k: 2, x: 100, y: 50 };
    const [sx, sy] = plugin.toScreen(view, 3, -4);
    expect([sx, sy]).toEqual([106, 42]);
    expect(plugin.toGraph(view, sx, sy)).toEqual([3, -4]);
  });

  it("fits the nodes into the box and picks the node under the pointer", () => {
    const m = plugin.buildModel(sample);
    const sim = plugin.createSimulation(m);
    while (!sim.settled) sim.tick();
    const view = plugin.fitView(m, 600, 400);
    for (let i = 0; i < m.count; i++) {
      const [sx, sy] = plugin.toScreen(view, m.x[i]!, m.y[i]!);
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(600);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThanOrEqual(400);
    }
    const i = m.index.get("Projects/B.md")!;
    const [sx, sy] = plugin.toScreen(view, m.x[i]!, m.y[i]!);
    expect(plugin.pickNode(m, view, sx, sy)).toBe(i);
    expect(plugin.pickNode(m, view, -500, -500)).toBe(-1);
  });

  it("gives every color group and the shared one a color for both themes", () => {
    for (const dark of [true, false]) {
      const colors = new Set([-1, 0, 1, 2, 3, 11, 12].map((id) => plugin.groupColor(id, dark)));
      expect(colors.size).toBe(7);
    }
  });
});
