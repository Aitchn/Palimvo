import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canvasFileRefs, parseCanvas, serializeCanvas } from "./canvas.ts";
import { parseFrontmatter, propertyTags, removeProperty, setProperty } from "./frontmatter.ts";
import { extractWikiLinks, resolveWikiLink } from "./links.ts";
import { fileKind, normalizeVaultPath } from "./paths.ts";
import { extractInlineTags } from "./tags.ts";

// A small vault written the way Obsidian writes it. Keep the files byte-for-byte as Obsidian would.
const ROOT = fileURLToPath(new URL("../../../tests/fixtures/obsidian-sample/", import.meta.url));

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(rel, rel) : [rel];
  });
}
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const paths = walk("").filter((p) => !p.startsWith(".obsidian/"));

describe("obsidian sample vault", () => {
  it("has only paths the core accepts", () => {
    for (const path of walk("")) expect(normalizeVaultPath(path)).toBe(path);
    expect(paths.filter((p) => fileKind(p) === "markdown")).toHaveLength(5);
  });

  it("reads frontmatter of every type Obsidian writes", () => {
    const welcome = parseFrontmatter(read("Welcome.md"));
    expect(welcome.error).toBeUndefined();
    expect(welcome.properties).toMatchObject({
      title: "Welcome to the vault",
      aliases: ["Home", "Start"],
      published: false,
    });
    expect(welcome.properties.created).toBeTruthy();
    expect(propertyTags(welcome.properties)).toEqual(["meta", "onboarding/first-day"]);
    expect(propertyTags(parseFrontmatter(read("Projects/Alpha/Roadmap.md")).properties)).toEqual([
      "meta",
      "planning",
    ]);
  });

  it("finds links, embeds, blocks and inline tags while skipping code", () => {
    const body = parseFrontmatter(read("Welcome.md")).body;
    const links = extractWikiLinks(body);
    expect(links.map((l) => [l.target, l.heading ?? l.block ?? null, l.embed])).toEqual([
      ["Projects/Alpha/Roadmap", null, false],
      ["Roadmap", "Q2 goals", false],
      ["Daily/2026-01-05", "standup", false],
      ["Projects/Alpha/Roadmap", "Q2 goals", true],
      ["Attachments/diagram.png", null, true],
    ]);
    expect(links[0]!.alias).toBe("the roadmap");
    expect(extractInlineTags(body)).toEqual(["inline-tag", "welcome", "project/alpha"]);
  });

  it("resolves links the way Obsidian does", () => {
    const frozen = Object.freeze(paths);
    expect(resolveWikiLink("Roadmap", frozen, "Welcome.md")).toBe("Projects/Alpha/Roadmap.md");
    expect(resolveWikiLink("Welcome", frozen, "Daily/2026-01-05.md")).toBe("Welcome.md");
    // A name that exists at the vault root wins over a copy in the linking note's own folder.
    expect(resolveWikiLink("Same", frozen, "Archive/Other.md")).toBe("Same.md");
    expect(resolveWikiLink("Archive/Same", frozen, "Welcome.md")).toBe("Archive/Same.md");
    expect(resolveWikiLink("Same", frozen, "Welcome.md")).toBe("Same.md");
    expect(resolveWikiLink("Attachments/diagram.png", frozen)).toBe("Attachments/diagram.png");
    expect(resolveWikiLink("Missing", frozen)).toBeUndefined();
  });

  it("round-trips a canvas Obsidian wrote", () => {
    const source = read("Projects/Alpha/Board.canvas");
    const canvas = parseCanvas(source);
    expect(canvas.nodes.map((n) => n.type)).toEqual(["text", "file", "file", "link", "group"]);
    expect(canvas.edges).toHaveLength(2);
    expect(canvasFileRefs(canvas)).toEqual([
      "Projects/Alpha/Roadmap.md",
      "Attachments/diagram.png",
    ]);
    expect(JSON.parse(serializeCanvas(canvas))).toEqual(JSON.parse(source));
    for (const ref of canvasFileRefs(canvas)) expect(resolveWikiLink(ref, paths)).toBe(ref);
  });

  it("edits a property without touching the rest of the note", () => {
    const source = read("Projects/Alpha/Roadmap.md");
    const edited = setProperty(source, "status", "done");
    expect(edited).toBe(source.replace("status: active", "status: done"));
    expect(removeProperty(edited, "status")).not.toContain("status:");
  });
});
