import { describe, expect, it } from "vitest";
import { extractWikiLinks, linkResolver, noteTitle, resolveWikiLink } from "./links.ts";

describe("extractWikiLinks", () => {
  it("parses targets, headings, aliases and embeds", () => {
    const md = "See [[Note A]], [[folder/B#Intro|the intro]] and ![[diagram.canvas]].";
    expect(extractWikiLinks(md)).toEqual([
      { target: "Note A", heading: undefined, alias: undefined, embed: false },
      { target: "folder/B", heading: "Intro", alias: "the intro", embed: false },
      { target: "diagram.canvas", heading: undefined, alias: undefined, embed: true },
    ]);
  });

  it("ignores links inside code", () => {
    expect(extractWikiLinks("`[[nope]]`\n```\n[[nope2]]\n```\n[[yes]]")).toHaveLength(1);
  });
});

describe("resolveWikiLink", () => {
  const paths = [
    "Welcome.md",
    "notes/Idea.md",
    "archive/notes/Idea.md",
    "boards/plan.canvas",
    "a/Same.md",
    "b/Same.md",
  ];

  it("matches exact paths and adds .md", () => {
    expect(resolveWikiLink("Welcome", paths)).toBe("Welcome.md");
    expect(resolveWikiLink("notes/Idea", paths)).toBe("notes/Idea.md");
    expect(resolveWikiLink("boards/plan.canvas", paths)).toBe("boards/plan.canvas");
  });

  it("is case-insensitive", () => {
    expect(resolveWikiLink("welcome", paths)).toBe("Welcome.md");
  });

  it("prefers the linking note's folder, then the shortest path", () => {
    expect(resolveWikiLink("Same", paths, "b/Other.md")).toBe("b/Same.md");
    expect(resolveWikiLink("Idea", paths)).toBe("notes/Idea.md");
    expect(resolveWikiLink("plan.canvas", paths)).toBe("boards/plan.canvas");
  });

  it("returns undefined for missing notes", () => {
    expect(resolveWikiLink("Nope", paths)).toBeUndefined();
    expect(resolveWikiLink("  ", paths)).toBeUndefined();
  });

  it("reuses lookup tables only for frozen lists, so a changed list is never answered from old tables", () => {
    const list = ["a/Note.md", "b/Other.md", "c/Last.md"];
    expect(resolveWikiLink("Other", list)).toBe("b/Other.md");
    list[1] = "b/Renamed.md";
    expect(resolveWikiLink("Other", list)).toBeUndefined();
    const frozen = Object.freeze(["x/One.md"]);
    expect(linkResolver(frozen)).toBe(linkResolver(frozen));
    expect(linkResolver(list)).not.toBe(linkResolver(list));
  });

  it("gives the same answers as a scan of every path", () => {
    // The original linear-scan algorithm, kept as the reference.
    const reference = (target: string, all: readonly string[], from?: string) => {
      const clean = target.trim().replace(/^\/+/, "");
      if (clean === "") return undefined;
      const candidates = [clean, `${clean}.md`].map((c) => c.toLowerCase());
      const byLower = new Map<string, string>();
      for (const p of all) byLower.set(p.toLowerCase(), p);
      for (const c of candidates) if (byLower.get(c)) return byLower.get(c);
      if (from?.includes("/")) {
        const folder = from.slice(0, from.lastIndexOf("/") + 1).toLowerCase();
        for (const c of candidates) if (byLower.get(folder + c)) return byLower.get(folder + c);
      }
      let best: string | undefined;
      for (const p of all) {
        const lower = p.toLowerCase();
        if (candidates.some((c) => lower.endsWith(`/${c}`)) && (!best || p.length < best.length))
          best = p;
      }
      return best;
    };
    const parts = ["a", "B", "ab", "x y", "Note", "note.md", "n.canvas", "deep"];
    let seed = 7;
    const pick = () => parts[(seed = (seed * 31 + 11) % 997) % parts.length]!;
    const all = Array.from(
      { length: 300 },
      () => Array.from({ length: 1 + (seed % 4) }, pick).join("/") + (seed % 3 ? ".md" : ""),
    );
    for (let i = 0; i < 500; i++) {
      const target = Array.from({ length: 1 + (i % 3) }, pick).join("/");
      const from = i % 2 ? all[i % all.length] : undefined;
      expect(resolveWikiLink(target, all, from)).toBe(reference(target, all, from));
    }
  });
});

describe("noteTitle", () => {
  it("strips folder and .md", () => {
    expect(noteTitle("a/b/My Note.md")).toBe("My Note");
    expect(noteTitle("board.canvas")).toBe("board.canvas");
  });
});

describe("block references", () => {
  it("separates block ids from headings", () => {
    expect(extractWikiLinks("[[Note#^abc123]] and [[Note#Heading]]")).toEqual([
      { target: "Note", block: "abc123", heading: undefined, alias: undefined, embed: false },
      { target: "Note", heading: "Heading", block: undefined, alias: undefined, embed: false },
    ]);
  });

  it("ignores links inside ~~~ fences", () => {
    expect(extractWikiLinks("~~~\n[[no]]\n~~~\n[[yes]]")).toHaveLength(1);
  });
});

describe("code spans and unicode", () => {
  it("skips multi-backtick code spans", () => {
    expect(
      extractWikiLinks("``[[hidden]]`` and ``a ` b [[hidden2]]`` and [[shown]]").map(
        (l) => l.target,
      ),
    ).toEqual(["shown"]);
  });

  it("matches composed and decomposed spellings alike", () => {
    expect(resolveWikiLink("café", ["café.md"])).toBe("café.md");
  });
});

describe("relative paths", () => {
  const paths = ["notes/a.md", "notes/img/cat.png", "img/cat.png", "root.png", "other/b.md"];
  const at = (target: string, from?: string) => resolveWikiLink(target, paths, from);

  it("follows ./ and ../ from the note's folder", () => {
    expect(at("./img/cat.png", "notes/a.md")).toBe("notes/img/cat.png");
    expect(at("../img/cat.png", "notes/a.md")).toBe("img/cat.png");
    expect(at("../root.png", "notes/a.md")).toBe("root.png");
    expect(at("../notes/./img/cat.png", "other/b.md")).toBe("notes/img/cat.png");
    expect(at("./root.png", "root.md")).toBe("root.png");
    expect(at("../other/b", "notes/a.md")).toBe("other/b.md");
  });

  it("does not guess when a relative path leads nowhere", () => {
    expect(at("../cat.png", "notes/a.md")).toBeUndefined();
    expect(at("../../x.png", "notes/a.md")).toBeUndefined();
    expect(at("../root.png", "root.md")).toBeUndefined();
    expect(at("./cat.png", "other/b.md")).toBeUndefined();
  });
});
