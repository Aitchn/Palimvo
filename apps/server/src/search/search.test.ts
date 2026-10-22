import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VaultService } from "../vault/service.ts";
import { tempVaults } from "../vault/testing.ts";
import { createVaultIndexes, withFallback, type SearchIndex, type VaultIndexes } from "./index.ts";

let vaults: VaultService;
let indexes: VaultIndexes;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ vaults, dispose } = await tempVaults());
  await vaults.createVault("demo");
  indexes = createVaultIndexes(vaults);
});
afterEach(() => dispose());

const write = (path: string, content: string) => vaults.writeFile("demo", path, content);
const find = async (
  query: string,
  options: { limit?: number; offset?: number; folder?: string } = {},
) => indexes.search.search("demo", query, { limit: 50, offset: 0, ...options });
const paths = (page: { hits: { path: string }[] }) => page.hits.map((h) => h.path);

describe("search", () => {
  beforeEach(async () => {
    await write("Plan.md", "# Plan\n\nShip the search panel.\nSecond line about Search.\n");
    await write("notes/Ideas.md", "Maybe a Plan for the graph view.\n");
    await write(
      "notes/決策紀錄.md",
      "今天決定使用 SQLite 當作伺服器的資料庫。\n第二行沒有關鍵字。\n",
    );
    await write("log/2026.md", "混合 mixed 內容：Palimvo 搜尋功能 works.\n");
    await write(
      "board.canvas",
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", text: "canvas search text", x: 0, y: 0, width: 100, height: 50 },
        ],
        edges: [],
      }),
    );
    await write("data.txt", "search in a plain text file");
  });

  it("finds English words regardless of case, with matching lines", async () => {
    const page = await find("SEARCH");
    expect(paths(page).sort()).toEqual(["Plan.md", "board.canvas"]);
    expect(page.total).toBe(2);
    const plan = page.hits.find((h) => h.path === "Plan.md")!;
    expect(plan.matches).toEqual([
      { line: 3, text: "Ship the search panel." },
      { line: 4, text: "Second line about Search." },
    ]);
  });

  it("finds Chinese words of two characters and of one", async () => {
    expect(paths(await find("決策"))).toEqual(["notes/決策紀錄.md"]);
    expect(paths(await find("資料庫"))).toEqual(["notes/決策紀錄.md"]);
    expect(paths(await find("決"))).toEqual(["notes/決策紀錄.md"]);
    expect(paths(await find("搜尋"))).toEqual(["log/2026.md"]);
    expect(paths(await find("策紀"))).toEqual(["notes/決策紀錄.md"]);
    expect((await find("決策")).hits[0]!.titleMatch).toBe(true);
  });

  it("answers mixed-language queries and requires every term", async () => {
    expect(paths(await find("palimvo 搜尋"))).toEqual(["log/2026.md"]);
    expect(paths(await find("mixed 內容"))).toEqual(["log/2026.md"]);
    expect(paths(await find("SQLite 資料庫"))).toEqual(["notes/決策紀錄.md"]);
    expect(paths(await find("SQLite palimvo"))).toEqual([]);
  });

  it("keeps a quoted phrase together", async () => {
    expect(paths(await find('"search panel"'))).toEqual(["Plan.md"]);
    expect(paths(await find('"panel search"'))).toEqual([]);
  });

  it("ranks name matches first, then files with more occurrences", async () => {
    const page = await find("plan");
    expect(paths(page)).toEqual(["Plan.md", "notes/Ideas.md"]);
    expect(page.hits[0]!.titleMatch).toBe(true);
    expect(page.hits[1]!.titleMatch).toBe(false);
  });

  it("matches a name even when the content does not", async () => {
    await write("Roadmap.md", "nothing relevant");
    const page = await find("roadmap");
    expect(page.hits).toEqual([{ path: "Roadmap.md", titleMatch: true, matches: [] }]);
  });

  it("searches canvas text but not other kinds of file", async () => {
    expect(paths(await find("canvas search"))).toEqual(["board.canvas"]);
    expect(paths(await find("plain text"))).toEqual([]);
  });

  it("pages results and restricts them to a folder", async () => {
    for (let i = 0; i < 5; i++) await write(`bulk/n${i}.md`, "bulkword here");
    const first = await find("bulkword", { limit: 2 });
    const second = await find("bulkword", { limit: 2, offset: 2 });
    const third = await find("bulkword", { limit: 2, offset: 4 });
    expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
    expect([...paths(first), ...paths(second), ...paths(third)]).toEqual(
      [0, 1, 2, 3, 4].map((i) => `bulk/n${i}.md`),
    );
    expect(paths(await find("plan", { folder: "notes" }))).toEqual(["notes/Ideas.md"]);
    expect(paths(await find("plan", { folder: "notes/" }))).toEqual(["notes/Ideas.md"]);
    // "not" must not match the folder "notes".
    expect(paths(await find("plan", { folder: "note" }))).toEqual([]);
  });

  it("returns nothing for an empty query", async () => {
    expect((await find("   ")).hits).toEqual([]);
  });

  it("follows changes to files", async () => {
    await write("Plan.md", "now about zebras");
    expect(paths(await find("zebras"))).toEqual(["Plan.md"]);
    expect(paths(await find("ship the search panel"))).toEqual([]);
    await vaults.deleteFile("demo", "Plan.md");
    expect(paths(await find("zebras"))).toEqual([]);
  });

  it("finds files that were never read into memory (cache off)", async () => {
    const off = await tempVaults({ cache: { enabled: false } });
    try {
      await off.vaults.createVault("demo");
      await off.vaults.writeFile("demo", "a.md", "uncached 內容");
      const i = createVaultIndexes(off.vaults);
      const page = await i.search.search("demo", "內容", { limit: 10, offset: 0 });
      expect(paths(page)).toEqual(["a.md"]);
    } finally {
      await off.dispose();
    }
  });
});

describe("search index fallback", () => {
  it("sends queries the primary cannot answer to the fallback", async () => {
    const calls: string[] = [];
    const page = { query: "", total: 0, offset: 0, limit: 1, hits: [] };
    const trigram: SearchIndex = {
      // Like FTS5 trigram: nothing shorter than 3 characters.
      supports: (q) => [...q.trim()].length >= 3,
      search: async () => (calls.push("primary"), page),
    };
    const memory: SearchIndex = {
      supports: () => true,
      search: async () => (calls.push("fallback"), page),
    };
    const index = withFallback(trigram, memory);
    await index.search("v", "決策紀錄", { limit: 1, offset: 0 });
    await index.search("v", "決策", { limit: 1, offset: 0 });
    expect(calls).toEqual(["primary", "fallback"]);
  });

  it("is used by createVaultIndexes when a primary is given", async () => {
    const calls: string[] = [];
    const page = { query: "", total: 0, offset: 0, limit: 1, hits: [] };
    const idx = createVaultIndexes(vaults, {
      search: () => ({
        supports: (q) => q.length >= 3,
        search: async () => (calls.push("p"), page),
      }),
    });
    await idx.search.search("demo", "abc", { limit: 1, offset: 0 });
    await idx.search.search("demo", "ab", { limit: 1, offset: 0 });
    expect(calls).toEqual(["p"]);
  });
});

describe("links", () => {
  beforeEach(async () => {
    await write(
      "Home.md",
      "# Home\n\nSee [[Plan]] and [[notes/Ideas|ideas]].\nAlso [[Missing note]].\n",
    );
    await write("Plan.md", "Back to [[Home]].\n\n```\n[[Plan]] in code is not a link\n```\n");
    await write("notes/Ideas.md", "Uses ![[Plan]] and [[plan#Heading]] and `[[Home]]`.\n");
    await write(
      "board.canvas",
      JSON.stringify({
        nodes: [
          { id: "a", type: "file", file: "Plan.md", x: 0, y: 0, width: 10, height: 10 },
          { id: "b", type: "text", text: "mentions [[Home]]", x: 0, y: 0, width: 10, height: 10 },
        ],
        edges: [],
      }),
    );
  });

  it("lists backlinks with their lines", async () => {
    const back = await indexes.links.backlinks("demo", "Plan.md");
    expect(back).toEqual([
      { path: "Home.md", lines: [{ line: 3, text: "See [[Plan]] and [[notes/Ideas|ideas]]." }] },
      { path: "board.canvas", lines: [] },
      {
        path: "notes/Ideas.md",
        lines: [{ line: 1, text: "Uses ![[Plan]] and [[plan#Heading]] and `[[Home]]`." }],
      },
    ]);
  });

  it("ignores links in code and a note's links to itself", async () => {
    const back = await indexes.links.backlinks("demo", "Home.md");
    expect(back.map((b) => b.path)).toEqual(["Plan.md", "board.canvas"]);
    expect(
      (await indexes.links.backlinks("demo", "Plan.md")).some((b) => b.path === "Plan.md"),
    ).toBe(false);
  });

  it("matches the target's path without regard to case", async () => {
    expect(
      (await indexes.links.backlinks("demo", process.platform === "win32" ? "plan.md" : "Plan.md"))
        .length,
    ).toBe(3);
  });

  it("lists outgoing links, resolved or not", async () => {
    expect(await indexes.links.outlinks("demo", "Home.md")).toEqual([
      { target: "Plan", path: "Plan.md", embed: false },
      { target: "notes/Ideas", path: "notes/Ideas.md", embed: false },
      { target: "Missing note", path: null, embed: false },
    ]);
    expect(await indexes.links.outlinks("demo", "board.canvas")).toEqual([
      { target: "Home", path: "Home.md", embed: false },
      { target: "Plan.md", path: "Plan.md", embed: true },
    ]);
  });

  it("builds the graph", async () => {
    const graph = await indexes.links.graph("demo");
    expect(graph.nodes.map((n) => n.path).sort()).toEqual(
      ["Home.md", "Plan.md", "Welcome.md", "board.canvas", "notes/Ideas.md"].sort(),
    );
    expect(graph.nodes.find((n) => n.path === "notes/Ideas.md")).toEqual({
      path: "notes/Ideas.md",
      title: "Ideas",
      kind: "markdown",
    });
    const edge = (from: string, to: string) =>
      graph.edges.find((e) => e.from === from && e.to === to);
    expect(edge("Home.md", "Plan.md")).toEqual({ from: "Home.md", to: "Plan.md", embed: false });
    // A plain link and an embed between the same files: one edge, shown as a link.
    expect(edge("notes/Ideas.md", "Plan.md")).toEqual({
      from: "notes/Ideas.md",
      to: "Plan.md",
      embed: false,
    });
    expect(edge("board.canvas", "Plan.md")).toEqual({
      from: "board.canvas",
      to: "Plan.md",
      embed: true,
    });
    expect(graph.edges.some((e) => e.from === e.to)).toBe(false);
    expect(graph.unresolved).toContainEqual({ from: "Home.md", target: "Missing note" });
    // Links in code do not count.
    expect(graph.unresolved.some((u) => u.from === "Plan.md")).toBe(false);
  });

  it("follows renames and edits", async () => {
    await vaults.move("demo", "Plan.md", "Roadmap.md");
    expect((await indexes.links.backlinks("demo", "Plan.md")).map((b) => b.path)).toEqual([]);
    await write("Home.md", "See [[Roadmap]].");
    expect((await indexes.links.backlinks("demo", "Roadmap.md")).map((b) => b.path)).toEqual([
      "Home.md",
    ]);
  });
});
