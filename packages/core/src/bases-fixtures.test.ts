import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baseFile, parseBase, queryBase, updateBaseSource, type FileValue } from "./bases.ts";
import { linkResolver } from "./links.ts";

// Bases written in the syntax the Obsidian documentation shows. Keep them as Obsidian would write them.
const ROOT = fileURLToPath(new URL("../../../tests/fixtures/obsidian-bases/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = dir ? `${dir}/${name}` : name;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
}
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const notePaths = walk("").filter((p) => p.endsWith(".md"));
const NOW = Date.parse("2026-03-01T12:00:00Z");
const files: FileValue[] = notePaths.map((path) =>
  baseFile({ path, content: read(path), mtime: NOW, ctime: NOW }, notePaths),
);
const names = (rows: { path: string }[]) => rows.map((r) => r.path);

describe("Obsidian Bases fixtures", () => {
  it("runs a table and cards view with formulas, grouping, sorting and display names", () => {
    const base = parseBase(read("Views/Books.base"));
    expect(base.views.map((v) => v.type)).toEqual(["table", "cards"]);
    expect(base.properties?.["formula.formatted_price"]?.displayName).toBe("Price");

    const table = queryBase(base, files, { now: NOW });
    expect(table.errors).toEqual([]);
    expect(names(table.rows)).toEqual(["Books/Neuromancer.md", "Books/Dune.md", "Books/Emma.md"]);
    expect(table.columns.map((c) => c.label)).toEqual([
      "Name",
      "author",
      "Price",
      "Price per year",
    ]);
    expect(table.rows[1]!.cells).toMatchObject({
      "file.name": "Dune",
      "formula.formatted_price": "9.50 dollars",
      "formula.ppu": "0.16",
    });
    expect(table.groups!.map((g) => [g.label, g.rows.length])).toEqual([
      ["done", 1],
      ["reading", 1],
      ["todo", 1],
    ]);

    const cards = queryBase(base, files, { view: "Cheap", now: NOW });
    expect(names(cards.rows)).toEqual(["Books/Dune.md", "Books/Emma.md"]);
    expect(cards.columns.map((c) => c.id)).toEqual(["file.name", "note.price"]);
    expect(cards.rows[0]!.cells["note.price"]).toBe(9.5);
  });

  it("combines and / or / not filters with folders, tags and date comparison", () => {
    const base = parseBase(read("Views/Tasks.base"));
    const r = queryBase(base, files, { now: NOW });
    expect(r.errors).toEqual([]);
    // Open (todo) tasks plus the one tagged "home", ordered by due date.
    expect(names(r.rows)).toEqual([
      "Tasks/Pay-rent.md",
      "Tasks/Write-report.md",
      "Tasks/Plan-trip.md",
    ]);
    expect(r.rows.map((x) => x.cells["formula.overdue"])).toEqual(["late", "", ""]);
  });

  it("finds notes linking to `this.file`, negating a tag", () => {
    const base = parseBase(read("Views/Backlinks.base"));
    const dune = files.find((f) => f.path === "Books/Dune.md")!;
    const r = queryBase(base, files, { now: NOW, thisFile: dune });
    expect(r.errors).toEqual([]);
    // Emma links to Dune; the task that links to it is excluded by the tag filter.
    expect(names(r.rows)).toEqual(["Books/Emma.md"]);
    expect(r.rows[0]!.cells).toMatchObject({
      "file.folder": "Books",
      "file.links": ["Books/Dune.md"],
    });
  });

  it("reads tags from properties (list or single string) and from the text", () => {
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("Books/Neuromancer.md")!.tags).toEqual(["book"]);
    expect(byPath.get("Books/Emma.md")!.tags).toEqual(["book", "classic", "to-read"]);
    expect(byPath.get("Tasks/Plan-trip.md")!.tags).toEqual(["task", "travel/summer"]);
  });

  it("keeps fields it does not model when a base is edited", () => {
    const source = read("Views/Books.base");
    const base = parseBase(source);
    base.views[0]!.limit = 5;
    const saved = updateBaseSource(source, base);
    expect(saved).toContain("summaries:");
    expect(saved).toContain("price: Average");
    expect(parseBase(saved).views[0]!.limit).toBe(5);
  });

  it("matches text case-sensitively and accepts a shared link resolver", () => {
    const [file] = files;
    const base = parseBase(
      "filters: 'author.contains(\"herbert\")'\nviews: [{type: table, name: t}]",
    );
    expect(queryBase(base, files, { now: NOW }).rows).toEqual([]);
    const resolver = linkResolver(notePaths);
    const viaResolver = baseFile(
      { path: file!.path, content: read(file!.path), mtime: NOW },
      resolver,
    );
    expect(viaResolver.links).toEqual(file!.links);
  });
});
