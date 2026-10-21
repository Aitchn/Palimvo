import { describe, expect, it } from "vitest";
import {
  basename,
  dirname,
  fileKind,
  isInside,
  isValidVaultId,
  joinPath,
  mediaOf,
  normalizeVaultPath,
  pathKey,
  samePath,
} from "./paths.ts";

describe("normalizeVaultPath", () => {
  it("normalizes separators and dot segments", () => {
    expect(normalizeVaultPath("notes//a/./b.md")).toBe("notes/a/b.md");
    expect(normalizeVaultPath("notes\\a.md")).toBe("notes/a.md");
  });

  it("keeps ordinary names, including spaces, unicode and dotfiles", () => {
    expect(normalizeVaultPath("日本語/my note (1).md")).toBe("日本語/my note (1).md");
    expect(normalizeVaultPath(".obsidian/app.json")).toBe(".obsidian/app.json");
    expect(normalizeVaultPath("a/.gitkeep")).toBe("a/.gitkeep");
  });

  it.each([
    "",
    "   ",
    "../x.md",
    "a/../../x",
    "/etc/passwd",
    "C:/x",
    "c:\\x",
    "a\0b",
    ".git/config",
    "a/.git/HEAD",
    ".Git/HEAD",
    ".GIT./config",
    ".palimvo/proposals/x.json",
    "a/.PaLiMvO/home.json",
    ".palimvo. /home.json",
    ".palimvo::$INDEX_ALLOCATION/config.json",
    ".aivault/collab/x.json",
    ".AIVAULT/source-schema.json",
    "a/.AiVaUlT/proposals/x",
    "con",
    "notes/NUL.md",
    "Aux.txt",
    "com1.md",
    "LPT9",
    "what?.md",
    'say "hi".md',
    "a|b.md",
    "<x>.md",
    "star*.md",
    "trailing-dot.",
    "trailing-space ",
    "a/b\u0007c.md",
    "x".repeat(256),
    `${"a/".repeat(600)}b`,
  ])("rejects %j", (input) => {
    expect(() => normalizeVaultPath(input)).toThrow();
  });

  it("accepts names that merely resemble device names", () => {
    expect(normalizeVaultPath("console.md")).toBe("console.md");
    expect(normalizeVaultPath("com10.md")).toBe("com10.md");
  });
});

describe("isValidVaultId", () => {
  it("accepts simple ids and rejects others", () => {
    expect(isValidVaultId("my-vault_1")).toBe(true);
    expect(isValidVaultId("../x")).toBe(false);
    expect(isValidVaultId("-x")).toBe(false);
    expect(isValidVaultId("")).toBe(false);
    expect(isValidVaultId("nul")).toBe(false);
    expect(isValidVaultId("a".repeat(65))).toBe(false);
  });
});

describe("path helpers", () => {
  it("compares paths the way Windows and macOS do", () => {
    expect(samePath("Notes/Idea.md", "notes/idea.MD")).toBe(true);
    expect(samePath("é.md", "e\u0301.md")).toBe(true);
    expect(samePath("a.md", "b.md")).toBe(false);
    expect(pathKey("A/B")).toBe("a/b");
  });

  it("splits and joins", () => {
    expect(dirname("a/b/c.md")).toBe("a/b");
    expect(dirname("c.md")).toBe("");
    expect(basename("a/b/c.md")).toBe("c.md");
    expect(basename("c.md")).toBe("c.md");
    expect(joinPath("a", "", "b.md")).toBe("a/b.md");
    expect(joinPath("", "b.md")).toBe("b.md");
  });

  it("tells whether a path is inside a folder", () => {
    expect(isInside("Docs/a.md", "docs")).toBe(true);
    expect(isInside("docs", "docs")).toBe(true);
    expect(isInside("docs-old/a.md", "docs")).toBe(false);
    expect(isInside("anything.md", "")).toBe(true);
  });
});

describe("fileKind", () => {
  it("detects markdown, canvas and base", () => {
    expect(fileKind("a/B.MD")).toBe("markdown");
    expect(fileKind("board.canvas")).toBe("canvas");
    expect(fileKind("tasks.base")).toBe("base");
    expect(fileKind("img.png")).toBe("other");
  });
});

describe("mediaOf", () => {
  it("knows media by extension and never treats svg as an image", () => {
    expect(mediaOf("a/b.PNG")).toEqual({ kind: "image", type: "image/png" });
    expect(mediaOf("clip.mp4")?.kind).toBe("video");
    expect(mediaOf("pic.svg")).toBeUndefined();
    expect(mediaOf("noext")).toBeUndefined();
  });
});
