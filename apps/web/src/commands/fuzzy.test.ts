import { describe, expect, it } from "vitest";
import { fuzzyScore, rank } from "./fuzzy.ts";

describe("fuzzyScore", () => {
  it("matches letters in order, not necessarily next to each other", () => {
    expect(fuzzyScore("rdm", "docs/Readme.md")).not.toBeNull();
    expect(fuzzyScore("mdr", "docs/Readme.md")).toBeNull();
  });

  it("ignores case and requires every word", () => {
    expect(fuzzyScore("PLAN proj", "Projects/Plan.md")).not.toBeNull();
    expect(fuzzyScore("plan zzz", "Projects/Plan.md")).toBeNull();
  });

  it("works for Chinese and mixed queries", () => {
    expect(fuzzyScore("筆記", "專案/筆記本.md")).not.toBeNull();
    expect(fuzzyScore("專案 plan", "專案/Plan.md")).not.toBeNull();
    expect(fuzzyScore("簡", "專案/筆記本.md")).toBeNull();
  });
});

describe("rank", () => {
  const files = [
    "Archive/old plan.md",
    "Projects/Plan.md",
    "Projects/Roadmap.md",
    "Notes/planet.md",
  ];

  it("puts file-name matches and tighter matches first", () => {
    expect(rank("plan", files, (f) => f)[0]).toBe("Projects/Plan.md");
  });

  it("drops non-matches and keeps order for an empty query", () => {
    expect(rank("roadm", files, (f) => f)).toEqual(["Projects/Roadmap.md"]);
    expect(rank("", files, (f) => f)).toEqual(files);
  });

  it("limits the result", () => {
    expect(rank("", files, (f) => f, 2)).toHaveLength(2);
  });
});
