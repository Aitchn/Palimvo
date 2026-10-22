import { describe, expect, it } from "vitest";
import { globProblem, matchesGlob, pathAllowed } from "./globs.ts";

describe("matchesGlob", () => {
  it("treats a plain pattern as a folder or file", () => {
    expect(matchesGlob("decisions", "decisions/0001-a.md")).toBe(true);
    expect(matchesGlob("decisions", "decisions/sub/b.md")).toBe(true);
    expect(matchesGlob("decisions", "decisions")).toBe(true);
    expect(matchesGlob("decisions", "decisions-old/x.md")).toBe(false);
    expect(matchesGlob("notes/a.md", "notes/a.md")).toBe(true);
    expect(matchesGlob("notes/a.md", "notes/a.md.bak")).toBe(false);
  });

  it("matches * inside one segment", () => {
    expect(matchesGlob("notes/*", "notes/a.md")).toBe(true);
    expect(matchesGlob("notes/*", "notes/sub/b.md")).toBe(false);
    expect(matchesGlob("*.md", "a.md")).toBe(true);
    expect(matchesGlob("*.md", "dir/a.md")).toBe(false);
    expect(matchesGlob("notes/a*c.md", "notes/abc.md")).toBe(true);
    expect(matchesGlob("notes/a*c.md", "notes/ab.md")).toBe(false);
  });

  it("matches ** across segments, including none", () => {
    expect(matchesGlob("**", "a.md")).toBe(true);
    expect(matchesGlob("**", "a/b/c.md")).toBe(true);
    expect(matchesGlob("decisions/**", "decisions/a.md")).toBe(true);
    expect(matchesGlob("decisions/**", "decisions/a/b.md")).toBe(true);
    expect(matchesGlob("decisions/**", "other/a.md")).toBe(false);
    expect(matchesGlob("a/**/z.md", "a/z.md")).toBe(true);
    expect(matchesGlob("a/**/z.md", "a/b/c/z.md")).toBe(true);
    expect(matchesGlob("a/**/z.md", "a/b/c/y.md")).toBe(false);
  });

  it("is case sensitive and does not treat regex characters specially", () => {
    expect(matchesGlob("Notes", "notes/a.md")).toBe(false);
    expect(matchesGlob("a.b/*", "a.b/x")).toBe(true);
    expect(matchesGlob("a.b/*", "aXb/x")).toBe(false);
    expect(matchesGlob("a+b/*", "a+b/x")).toBe(true);
  });

  it("never matches unsafe paths", () => {
    expect(matchesGlob("**", "../secret")).toBe(false);
    expect(matchesGlob("**", "a/../b")).toBe(false);
    expect(matchesGlob("**", "/etc/passwd")).toBe(false);
    expect(matchesGlob("**", "a\\b")).toBe(false);
    expect(matchesGlob("**", "")).toBe(false);
    expect(matchesGlob("../x", "../x")).toBe(false);
  });
});

describe("pathAllowed", () => {
  it("is true when any pattern covers the path", () => {
    expect(pathAllowed(["a", "b/**"], "b/x")).toBe(true);
    expect(pathAllowed(["a", "b/**"], "c/x")).toBe(false);
    expect(pathAllowed([], "a")).toBe(false);
  });
});

describe("globProblem", () => {
  it("explains refused patterns", () => {
    expect(globProblem("a/b")).toBeUndefined();
    expect(globProblem("**")).toBeUndefined();
    for (const bad of [
      "",
      "/a",
      "a/",
      "a//b",
      "a/./b",
      "a/../b",
      "a?b",
      "a[1]",
      "{a,b}",
      "!a",
      "a\\b",
      "a**",
      "x".repeat(201),
    ]) {
      expect(globProblem(bad), bad).toBeTypeOf("string");
    }
  });
});
