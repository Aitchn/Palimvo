import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The official plugins (plugins/*) run for real in a browser in tests/e2e/official-plugins.spec.ts.
// Here their logic is checked in jsdom against a fake `palimvo`.

// Vitest runs in apps/web.
const dir = (id: string) => `${path.resolve(process.cwd(), "../../plugins", id)}${path.sep}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = any;
const load = (id: string): Promise<Mod> => {
  const file = `${dir(id)}main.js`;
  return import(/* @vite-ignore */ file);
};

type Handler = (ctx: Record<string, unknown>) => unknown;

function fakePalimvo(
  id: string,
  vault: Record<string, string> = {},
  extras: { invoke?: () => Promise<unknown[]> } = {},
) {
  const strings = JSON.parse(readFileSync(`${dir(id)}locales/en.json`, "utf8")) as Record<
    string,
    string
  >;
  const registered = new Map<string, Handler>();
  const contributed = new Map<string, Handler>();
  const writes: Array<[string, string]> = [];
  const palimvo = {
    plugin: { id, version: "1.0.0" },
    i18n: {
      locale: "en",
      t: (key: string, params: Record<string, string | number> = {}) =>
        (strings[key] ?? key).replace(/\{(\w+)\}/g, (_, n: string) => String(params[n] ?? "")),
    },
    vault: {
      list: async (folder = "") =>
        Object.keys(vault)
          .filter((p) => !folder || p.startsWith(`${folder}/`))
          .map((p) => ({ path: p, name: p.split("/").pop(), kind: "file" })),
      read: async (path: string) => {
        if (!(path in vault)) throw new Error(`not found: ${path}`);
        return vault[path] as string;
      },
      write: async (path: string, content: string) => {
        vault[path] = content;
        writes.push([path, content]);
        return { revision: "r" };
      },
    },
    ui: {
      registerView: (key: string, fn: Handler) => registered.set(`view:${key}`, fn),
      registerCodeBlock: (key: string, fn: Handler) => registered.set(`code:${key}`, fn),
      registerViewer: (key: string, fn: Handler) => registered.set(`viewer:${key}`, fn),
      registerComponent: (key: string, fn: Handler) => registered.set(`component:${key}`, fn),
      openFile: vi.fn(),
    },
    events: { on: vi.fn(() => () => {}) },
    extensions: {
      invoke: extras.invoke ?? (async () => []),
      contribute: (plugin: string, point: string, fn: Handler) =>
        contributed.set(`${plugin}/${point}`, fn),
    },
  };
  return { palimvo, registered, contributed, writes, vault };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("kanban", () => {
  const notes = () => ({
    "tasks/a.md": "---\nstatus: todo\ndue: 2026-01-02\n---\n# A",
    "tasks/b.md": "---\nstatus: doing\n---\n# B",
    "tasks/c.md": "# C without properties",
    "other/d.md": "---\nstatus: done\ntags: [x, y]\n---\n# D",
  });

  it("parses frontmatter scalars, lists and quotes, and ignores nesting", async () => {
    const { parseFrontmatter } = await load("kanban");
    expect(
      parseFrontmatter(
        '---\nstatus: "doing"\ntags: [a, "b c"]\nowners:\n  - ann\n  - bob\nnested:\n  k: v\n---\nbody',
      ),
    ).toMatchObject({ status: "doing", tags: ["a", "b c"], owners: ["ann", "bob"] });
    expect(parseFrontmatter("no frontmatter")).toEqual({});
  });

  it("sets a property without touching the rest, and adds frontmatter when missing", async () => {
    const { setProperty } = await load("kanban");
    expect(setProperty("---\nstatus: todo\nx: 1\n---\n# T\n", "status", "done")).toBe(
      "---\nstatus: done\nx: 1\n---\n# T\n",
    );
    expect(setProperty("---\nx: 1\n---\nbody", "status", "doing")).toBe(
      "---\nx: 1\nstatus: doing\n---\nbody",
    );
    expect(setProperty("# plain", "status", "todo")).toBe("---\nstatus: todo\n---\n# plain");
    // `$&` in a value is text, not a regexp replacement pattern.
    expect(setProperty("---\nstatus: a\n---\n", "status", "$&x")).toBe("---\nstatus: $&x\n---\n");
  });

  it("parses code block options", async () => {
    const { parseOptions } = await load("kanban");
    expect(parseOptions("folder: tasks\nfield: stage\ncolumns: a, b ,c\nnonsense")).toEqual({
      folder: "tasks",
      field: "stage",
      columns: ["a", "b", "c"],
    });
  });

  it("draws columns from the property, only cards that have it when no folder is set", async () => {
    const mod = await load("kanban");
    const { palimvo, registered } = fakePalimvo("kanban", notes());
    mod.default(palimvo);
    const el = document.createElement("div");
    document.body.append(el);
    await registered.get("view:board")!({ el });
    await settle();
    const names = [...el.querySelectorAll(".kb-col")].map((c) => (c as HTMLElement).dataset.column);
    expect(names).toEqual(["todo", "doing", "done"]);
    const cards = [...el.querySelectorAll(".kb-card")].map((c) => (c as HTMLElement).dataset.path);
    expect(cards.sort()).toEqual(["other/d.md", "tasks/a.md", "tasks/b.md"]);
    el.remove();
  });

  it("moves a card by rewriting the property of a fresh read", async () => {
    const mod = await load("kanban");
    const { palimvo, registered, vault } = fakePalimvo("kanban", notes());
    mod.default(palimvo);
    const el = document.createElement("div");
    document.body.append(el);
    await registered.get("code:kanban")!({ el, source: "folder: tasks" });
    await settle();
    // c.md has no property: it starts in the first column.
    expect(el.querySelector('[data-column="todo"] [data-path="tasks/c.md"]')).not.toBeNull();
    // Someone edits the note after the board read it; the move keeps their change.
    vault["tasks/b.md"] = "---\nstatus: doing\nowner: ann\n---\n# B";
    const select = el.querySelector('[data-path="tasks/b.md"] select') as HTMLSelectElement;
    select.value = "done";
    select.dispatchEvent(new Event("change"));
    await settle();
    expect(vault["tasks/b.md"]).toBe("---\nstatus: done\nowner: ann\n---\n# B");
    expect(el.querySelector('[data-column="done"] [data-path="tasks/b.md"]')).not.toBeNull();
    el.remove();
  });

  it("shows contributed badges and survives a failing contributor", async () => {
    const mod = await load("kanban");
    const ok = fakePalimvo("kanban", notes(), {
      invoke: async () => [
        [{ path: "tasks/a.md", text: "Due soon", tone: "warning" }],
        "junk",
        [{ nope: 1 }],
      ],
    });
    mod.default(ok.palimvo);
    const el = document.createElement("div");
    await ok.registered.get("code:kanban")!({ el, source: "folder: tasks" });
    await settle();
    expect(el.querySelector('[data-path="tasks/a.md"] .kb-badge.tone-warning')?.textContent).toBe(
      "Due soon",
    );
    const bad = fakePalimvo("kanban", notes(), {
      invoke: async () => {
        throw new Error("down");
      },
    });
    mod.default(bad.palimvo);
    const el2 = document.createElement("div");
    await bad.registered.get("code:kanban")!({ el: el2, source: "folder: tasks" });
    await settle();
    expect(el2.querySelectorAll(".kb-card")).toHaveLength(3);
  });
});

describe("kanban-due", () => {
  it("labels cards by days to go and skips missing or impossible dates", async () => {
    const { badges, parseDate } = await load("kanban-due");
    const { palimvo } = fakePalimvo("kanban-due");
    const now = new Date(2026, 5, 10, 15, 30);
    const card = (path: string, due?: unknown) => ({
      path,
      properties: due === undefined ? {} : { due },
    });
    const out = badges(
      palimvo,
      [
        card("a", "2026-06-08"),
        card("b", "2026-06-10"),
        card("c", "2026-06-11"),
        card("d", "2026-06-13"),
        card("e", "2026-07-01"),
        card("f", ["2026-06-10"]),
        card("g", "2026-02-31"),
        card("h", "soon"),
        card("i"),
      ],
      now,
    );
    expect(
      out.map((b: { path: string; text: string; tone: string }) => [b.path, b.text, b.tone]),
    ).toEqual([
      ["a", "Overdue by 2 d", "danger"],
      ["b", "Due today", "warning"],
      ["c", "Due tomorrow", "warning"],
      ["d", "Due in 3 d", "warning"],
      ["e", "Due in 21 d", "muted"],
      ["f", "Due today", "warning"],
    ]);
    expect(parseDate("2026-02-31")).toBeNull();
  });

  it("contributes to the card-badge point of kanban", async () => {
    const mod = await load("kanban-due");
    const { palimvo, contributed } = fakePalimvo("kanban-due");
    mod.default(palimvo);
    expect([...contributed.keys()]).toEqual(["kanban/card-badge"]);
    const answer = contributed.get("kanban/card-badge")!({ cards: [] });
    expect(answer).toEqual([]);
  });
});

describe("json-tree", () => {
  const open = async (text: string) => {
    const mod = await load("json-tree");
    const { palimvo, registered } = fakePalimvo("json-tree");
    mod.default(palimvo);
    const el = document.createElement("div");
    await registered.get("viewer:tree")!({ el, path: "data/x.json", readText: async () => text });
    return el;
  };

  it("draws nested data and folds deep branches", async () => {
    const el = await open(
      JSON.stringify({ a: 1, b: { c: { d: { e: "deep" } } }, list: [true, null] }),
    );
    expect(el.querySelectorAll("details").length).toBeGreaterThanOrEqual(4);
    const isOpen = (key: string) =>
      (
        [...el.querySelectorAll("details")].find((d) =>
          d.querySelector("summary")?.textContent?.startsWith(`${key}:`),
        ) as HTMLDetailsElement
      ).open;
    expect([isOpen("b"), isOpen("c"), isOpen("d")]).toEqual([true, false, false]);
    expect(el.textContent).toContain('"deep"');
  });

  it("keeps only matching branches while searching", async () => {
    const el = await open(JSON.stringify({ apple: { color: "red" }, pear: { color: "green" } }));
    const input = el.querySelector("input") as HTMLInputElement;
    input.value = "green";
    input.dispatchEvent(new Event("input"));
    expect(el.textContent).toContain("pear");
    expect(el.textContent).not.toContain("apple");
  });

  it("shows the parser's message for invalid JSON and caps long arrays", async () => {
    expect((await open("{oops")).querySelector(".jt-error")?.textContent).toMatch(
      /^Cannot read this JSON/,
    );
    const big = await open(JSON.stringify(Array.from({ length: 600 }, (_, i) => i)));
    expect(big.textContent).toContain("… 100 more");
  });
});

describe("chart-pack", () => {
  const draw = async (type: string, config: unknown, data?: unknown) => {
    const mod = await load("chart-pack");
    const { palimvo, registered } = fakePalimvo("chart-pack");
    mod.default(palimvo);
    const el = document.createElement("div");
    await registered.get(`component:${type}`)!({
      el,
      type,
      config,
      data,
      locale: "en",
      theme: "dark",
    });
    return el;
  };

  it("registers the three declared types", async () => {
    const mod = await load("chart-pack");
    const { palimvo, registered } = fakePalimvo("chart-pack");
    mod.default(palimvo);
    expect([...registered.keys()].sort()).toEqual([
      "component:radar",
      "component:sparkline",
      "component:treemap",
    ]);
  });

  it("radar: one polygon per series, a legend, and an empty message below three axes", async () => {
    const el = await draw("radar", {
      axes: ["A", "B", "C", "D"],
      series: [
        { name: "One", values: [1, 2, 3, 4] },
        { name: "Two", values: [4, "3", null, 1] },
      ],
    });
    expect(el.querySelectorAll("svg polygon[fill-opacity]")).toHaveLength(2);
    expect(el.querySelectorAll(".legend span")).toHaveLength(2);
    expect(
      (await draw("radar", { axes: ["A", "B"], series: [] })).querySelector(".empty")?.textContent,
    ).toContain("three axes");
  });

  it("radar: takes the top of the scale from max or rounds the largest value up", async () => {
    const { niceCeil, radarModel } = await load("chart-pack");
    expect([7, 42, 3.2, 0.3].map(niceCeil)).toEqual([10, 50, 4, 0.4]);
    expect(radarModel({ axes: ["a"], series: [{ values: [3] }], max: 5 }).max).toBe(5);
    expect(radarModel({ axes: ["a"], series: [{ values: [7] }] }).max).toBe(10);
  });

  it("treemap: areas add up to the whole and are proportional to the values", async () => {
    const { squarify, treemapLeaves } = await load("chart-pack");
    const leaves = treemapLeaves([
      {
        name: "Home",
        children: [
          { name: "Rent", value: 900 },
          { name: "Power", value: 100 },
        ],
      },
      { name: "Food", value: 400 },
      { name: "Zero", value: 0 },
      { name: "Bad", value: "x" },
    ]);
    expect(leaves.map((l: { name: string }) => l.name).sort()).toEqual(["Food", "Power", "Rent"]);
    const rects = squarify(leaves, 600, 320);
    const total = rects.reduce((a: number, r: { w: number; h: number }) => a + r.w * r.h, 0);
    expect(total).toBeCloseTo(600 * 320, 3);
    const area = (name: string) => {
      const r = rects.find((x: { leaf: { name: string } }) => x.leaf.name === name);
      return r.w * r.h;
    };
    expect(area("Rent") / area("Food")).toBeCloseTo(900 / 400, 3);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(320 + 1e-6);
    }
    const el = await draw("treemap", {
      items: [
        { name: "Food", value: 400 },
        { name: "Rent", value: 900 },
      ],
    });
    expect(el.querySelectorAll("svg rect")).toHaveLength(2);
    expect(el.querySelector("svg title")?.textContent).toContain("%");
  });

  it("sparkline: draws a line and shows the last value with its unit; data overrides config", async () => {
    const el = await draw(
      "sparkline",
      { values: [1, 2, 3], unit: "/d", label: "Visits" },
      { values: [5, 9, 7] },
    );
    expect(el.querySelector("polyline")).not.toBeNull();
    expect(el.querySelector("b")?.textContent).toBe("7/d");
    expect(el.querySelector("small")?.textContent).toBe("Visits");
    expect((await draw("sparkline", { values: [] })).querySelector(".empty")).not.toBeNull();
    const flat = await draw("sparkline", { values: [4, 4, 4] });
    expect(flat.querySelector("polyline")?.getAttribute("points")).not.toContain("NaN");
  });
});
