import { describe, expect, it } from "vitest";
import { extractInlineTags, normalizeTag, tagIsInside } from "./tags.ts";

describe("extractInlineTags", () => {
  it("finds tags, nested tags and unicode tags in order", () => {
    expect(
      extractInlineTags("Start #idea then #project/alpha and #日本語 and #idea again"),
    ).toEqual(["idea", "project/alpha", "日本語"]);
  });

  it("ignores headings, numbers, fragments of words, urls and code", () => {
    const md = [
      "# Heading",
      "#123 is not a tag",
      "mail a#b",
      "https://x.test/page#anchor",
      "`#inline`",
      "```",
      "#fenced",
      "```",
      "ok #real",
    ].join("\n");
    expect(extractInlineTags(md)).toEqual(["real"]);
  });

  it("accepts tags that mix digits and letters", () => {
    expect(extractInlineTags("#2024-plan #v2")).toEqual(["2024-plan", "v2"]);
  });
});

describe("tag helpers", () => {
  it("normalizes and nests", () => {
    expect(normalizeTag(" #Project/A ")).toBe("Project/A");
    expect(tagIsInside("project/a", "Project")).toBe(true);
    expect(tagIsInside("projects", "project")).toBe(false);
  });
});

it("skips multi-backtick code spans", () => {
  expect(extractInlineTags("``#hidden`` #shown")).toEqual(["shown"]);
});
