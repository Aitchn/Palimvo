import { parseBase } from "@palimvo/core";
import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/index.ts";
import { buildCondition, describeCondition, simpleFilter, toFilter } from "./FilterPanel.tsx";
import { countFilters, imageTarget, inputText, newBaseSource, parseInput } from "./model.ts";

describe("database cells", () => {
  it("turns typed text into the property's kind of value", () => {
    expect(parseInput("a, #b, ", ["x"])).toEqual(["a", "b"]);
    expect(parseInput("42", 1)).toBe(42);
    expect(parseInput("42", "text")).toBe("42");
    expect(parseInput("  ", "x")).toBeNull();
    expect(parseInput("true", null)).toBe(true);
  });

  it("shows a value as the text one would type", () => {
    expect(inputText(["a", "b"])).toBe("a, b");
    expect(inputText(null)).toBe("");
    expect(inputText(3)).toBe("3");
  });

  it("finds the image a cover cell names", () => {
    expect(imageTarget("![[cover.png|200]]")).toBe("cover.png");
    expect(imageTarget(["https://x.test/a.png", "b"])).toBe("https://x.test/a.png");
    expect(imageTarget("  ")).toBeNull();
    expect(imageTarget(5)).toBeNull();
  });
});

describe("filter conditions", () => {
  it("reads common conditions as words, in the interface language", async () => {
    const en = (await createI18n("en")).t;
    expect(describeCondition('file.hasTag("book")', en)).toBe("Has tag #book");
    expect(describeCondition('!file.inFolder("archive")', en)).toBe("Not in folder archive");
    expect(describeCondition("rating > 3", en)).toBe("rating > 3");
    const tw = (await createI18n("zh-TW")).t;
    expect(describeCondition('file.hasTag("book")', tw)).toBe("有標籤 #book");
  });

  it("builds an expression from the pieces of the condition form", () => {
    const base = { kind: "tag", negate: false, value: "#book", property: "", op: "==" } as const;
    expect(buildCondition(base)).toBe('file.hasTag("book")');
    expect(buildCondition({ ...base, negate: true })).toBe('!file.hasTag("book")');
    expect(buildCondition({ ...base, kind: "folder", value: "Notes" })).toBe(
      'file.inFolder("Notes")',
    );
    expect(
      buildCondition({ ...base, kind: "property", property: "rating", op: ">", value: "3" }),
    ).toBe("rating > 3");
    expect(buildCondition({ ...base, kind: "property", property: "status", value: "open" })).toBe(
      'status == "open"',
    );
    expect(buildCondition({ ...base, kind: "property", property: "due date", op: "filled" })).toBe(
      '!note["due date"].isEmpty()',
    );
    expect(
      buildCondition({ ...base, kind: "property", property: "tags", op: "contains", value: "x" }),
    ).toBe('tags.contains("x")');
    expect(buildCondition({ ...base, value: " " })).toBeNull();
    expect(buildCondition({ ...base, kind: "property", property: "" })).toBeNull();
  });

  it("edits simple lists of conditions and leaves nested ones to YAML", () => {
    expect(simpleFilter(undefined)).toEqual({ mode: "and", items: [] });
    expect(simpleFilter("a")).toEqual({ mode: "and", items: ["a"] });
    expect(simpleFilter({ or: ["a", "b"] })).toEqual({ mode: "or", items: ["a", "b"] });
    expect(simpleFilter({ and: ["a", { or: ["b"] }] })).toBeNull();
    expect(toFilter({ mode: "and", items: [] })).toBeUndefined();
    expect(toFilter({ mode: "or", items: ["a"] })).toEqual({ or: ["a"] });
    expect(countFilters({ and: ["a", "b"] })).toBe(2);
    expect(countFilters("")).toBe(0);
  });
});

describe("new database file", () => {
  it("writes settings the base parser reads back", () => {
    const source = newBaseSource({
      folder: "Tasks",
      tag: "#todo",
      columns: ["file.name", "status"],
      viewName: 'My "view"',
      type: "cards",
    });
    const base = parseBase(source);
    expect(base.filters).toEqual({ and: ['file.inFolder("Tasks")', 'file.hasTag("todo")'] });
    expect(base.views).toHaveLength(1);
    expect(base.views[0]).toMatchObject({
      type: "cards",
      name: 'My "view"',
      order: ["file.name", "status"],
    });
  });

  it("has no filters for all notes", () => {
    const base = parseBase(
      newBaseSource({ columns: ["file.name"], viewName: "All", type: "table" }),
    );
    expect(base.filters).toBeUndefined();
  });
});
