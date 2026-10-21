import { describe, expect, it } from "vitest";
import {
  baseFile,
  newRowTemplate,
  noteTags,
  parseBase,
  queryBase,
  setNoteProperty,
  updateBaseSource,
} from "./bases.ts";

const notes = {
  "books/Dune.md": "---\ntags: [book, scifi]\nrating: 5\nstatus: done\n---\n# Dune\n",
  "books/Emma.md":
    "---\ntags:\n  - book\n  - classic\nrating: 3\nstatus: reading\n---\nSee [[Dune]]",
  "books/Notes.md": "Just a note about #book/ideas and `#notatag`\n```\n#nope\n```",
  "work/Plan.md": "---\nstatus: todo\nprice: 10\nqty: 3\n---\n#work",
};
const paths = Object.keys(notes);
const files = paths.map((path, i) =>
  baseFile(
    { path, content: notes[path as keyof typeof notes], mtime: 1_700_000_000_000 + i },
    paths,
  ),
);

describe("noteTags", () => {
  it("reads frontmatter and inline tags, skipping code", () => {
    expect(noteTags(notes["books/Notes.md"])).toEqual(["book/ideas"]);
    expect(noteTags("---\ntags: 'a, #b'\n---\nx #c")).toEqual(["a", "b", "c"]);
  });
});

describe("queryBase", () => {
  it("filters by tag (nested tags count), sorts and groups by list values", () => {
    const base = parseBase(`
filters: file.hasTag("book")
views:
  - type: table
    name: Books
    order: [file.name, rating, status]
    sort:
      - property: rating
        direction: DESC
    groupBy:
      property: file.tags
`);
    const r = queryBase(base, files);
    expect(r.rows.map((x) => x.path)).toEqual(["books/Dune.md", "books/Emma.md", "books/Notes.md"]);
    expect(r.rows[0]!.cells).toMatchObject({ "file.name": "Dune", rating: 5, status: "done" });
    expect(r.groups!.map((g) => [g.label, g.rows.length])).toEqual([
      ["book", 2],
      ["book/ideas", 1],
      ["classic", 1],
      ["scifi", 1],
    ]);
    expect(r.errors).toEqual([]);
  });

  it("supports and/or/not, folders, comparisons, formulas and this", () => {
    const base = parseBase(`
formulas:
  total: price * qty
  label: 'if(formula.total > 20, "big", "small")'
filters:
  or:
    - file.inFolder("work")
    - and: ['rating >= 4', { not: ['status == "reading"'] }]
views:
  - type: cards
    name: c
    order: [file.name, formula.total, formula.label]
  - type: table
    name: links
    filters: file.hasLink(this.file)
`);
    const r = queryBase(base, files);
    expect(r.rows.map((x) => x.path)).toEqual(["books/Dune.md", "work/Plan.md"]);
    expect(r.rows[1]!.cells).toMatchObject({ "formula.total": 30, "formula.label": "big" });
    const dune = files[0]!;
    const back = queryBase({ ...base, filters: undefined }, files, {
      view: "links",
      thisFile: dune,
    });
    expect(back.rows.map((x) => x.path)).toEqual(["books/Emma.md"]);
  });

  it("reports broken expressions instead of throwing", () => {
    const r = queryBase(parseBase("filters: 'status == '\nviews: [{type: table, name: t}]"), files);
    expect(r.rows).toEqual([]);
    expect(r.errors.length).toBe(1);
  });

  it("lists what notes have for building filters", () => {
    const r = queryBase(parseBase(""), files);
    expect(r.available.tags).toContain("scifi");
    expect(r.available.properties).toEqual(["price", "qty", "rating", "status", "tags"]);
    expect(r.available.folders).toEqual(["books", "work"]);
    expect(r.columns[0]!.id).toBe("file.name");
  });
});

describe("parseBase", () => {
  it("rejects malformed files with a readable message", () => {
    expect(() => parseBase("views: 3")).toThrow(/views/);
    expect(() => parseBase("filters: {foo: 1}")).toThrow(/and \/ or \/ not/);
    expect(() => parseBase("a: [")).toThrow(/YAML/);
  });
  it("preserves an approved code-block view configuration through native edits", () => {
    const plugin = {
      id: "chart-pack",
      codeBlock: "chart-block",
      source: '{"file":"Charts/data.json"}',
    };
    const source =
      "# keep comment\n" +
      JSON.stringify({
        views: [
          { type: "plugin", name: "Chart", plugin },
          { type: "table", name: "Rows" },
        ],
      });
    const base = parseBase(source);
    expect(base.views[0]).toMatchObject({ type: "plugin", plugin });
    base.views[0]!.name = "Chart renamed";
    const saved = updateBaseSource(source, base);
    expect(saved).toContain("# keep comment");
    expect(parseBase(saved).views[0]).toMatchObject({
      name: "Chart renamed",
      type: "plugin",
      plugin,
    });
    expect(parseBase(saved).views[1]!.type).toBe("table");
  });
  it("validates plugin bindings without changing legacy table/cards defaults", () => {
    for (const plugin of [
      undefined,
      {},
      { id: "../bad", codeBlock: "chart", source: "" },
      { id: "x".repeat(65), codeBlock: "chart", source: "" },
      { id: "chart", codeBlock: "", source: "" },
      { id: "chart", codeBlock: "chart", source: "中".repeat(350000) },
    ]) {
      expect(() =>
        parseBase(JSON.stringify({ views: [{ type: "plugin", name: "Chart", plugin }] })),
      ).toThrow(/plugin/);
    }
    expect(parseBase("views: [{type: future, name: Other}]").views[0]!.type).toBe("table");
    expect(parseBase("views: [{type: cards, name: Cards}]").views[0]!.type).toBe("cards");
  });
  it("queries plugin views with the same native filters, sorting and limit", () => {
    const base = parseBase(
      JSON.stringify({
        filters: 'file.inFolder("books")',
        views: [
          {
            type: "plugin",
            name: "Chart",
            filters: "rating >= 3",
            sort: [{ property: "rating", direction: "DESC" }],
            limit: 1,
            plugin: { id: "chart", codeBlock: "chart", source: "" },
          },
        ],
      }),
    );
    const result = queryBase(base, files);
    expect(result.errors).toEqual([]);
    expect(result.view.type).toBe("plugin");
    expect(result.rows.map((row) => row.path)).toEqual(["books/Dune.md"]);
  });
});

describe("setNoteProperty", () => {
  it("adds, changes and removes properties, keeping the rest", () => {
    const text = "---\n# keep me\ntags: [a]\nstatus: todo\n---\nbody\n";
    expect(setNoteProperty(text, "status", "done")).toBe(
      "---\n# keep me\ntags: [a]\nstatus: done\n---\nbody\n",
    );
    expect(setNoteProperty("body", "rating", 4)).toBe("---\nrating: 4\n---\nbody");
    expect(setNoteProperty("---\nx: 1\n---\nbody", "x", null)).toBe("body");
    expect(setNoteProperty("---\n---\nbody", "tags", ["x", "y"])).toBe(
      "---\ntags:\n  - x\n  - y\n---\nbody",
    );
  });

  it("refuses to touch broken YAML", () => {
    expect(() => setNoteProperty("---\na: [\n---\n", "b", 1)).toThrow(/YAML/);
  });
});

describe("updateBaseSource", () => {
  it("rewrites only changed sections", () => {
    const src = '# my db\nfilters: file.hasTag("x") # tag\nviews:\n  - type: table\n    name: t\n';
    const base = parseBase(src);
    base.views[0]!.groupBy = { property: "status", direction: "ASC" };
    const out = updateBaseSource(src, base);
    expect(out).toContain('filters: file.hasTag("x") # tag');
    expect(parseBase(out).views[0]!.groupBy).toEqual({ property: "status", direction: "ASC" });
  });
});

describe("newRowTemplate", () => {
  it("collects simple tag, folder and property filters", () => {
    const base = parseBase(
      'filters:\n  and: [file.hasTag("book"), file.inFolder("books"), status == "todo"]\nviews: [{type: table, name: t}]',
    );
    expect(newRowTemplate(base)).toEqual({
      folder: "books",
      properties: { status: "todo", tags: ["book"] },
    });
  });
});
