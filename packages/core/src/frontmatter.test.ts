import { describe, expect, it } from "vitest";
import {
  FrontmatterError,
  parseFrontmatter,
  propertyTags,
  removeProperty,
  setProperty,
  splitFrontmatter,
} from "./frontmatter.ts";

const note = "---\ntitle: Hello\n# keep me\ntags: [a, b]\nstatus:   draft\n---\n# Body\n";

describe("splitFrontmatter", () => {
  it("splits a block from the body", () => {
    expect(splitFrontmatter(note)).toEqual({
      yaml: "title: Hello\n# keep me\ntags: [a, b]\nstatus:   draft",
      body: "# Body\n",
      eol: "\n",
    });
  });

  it("treats a missing or unclosed block as plain body", () => {
    expect(splitFrontmatter("# Just text\n").yaml).toBeNull();
    expect(splitFrontmatter("---\ntitle: x\nno end\n").yaml).toBeNull();
    expect(splitFrontmatter("text\n---\na: 1\n---\n").yaml).toBeNull();
  });

  it("handles CRLF, BOM and an empty block", () => {
    expect(splitFrontmatter("---\r\na: 1\r\n---\r\nbody").eol).toBe("\r\n");
    expect(splitFrontmatter("\uFEFF---\na: 1\n---\nbody").yaml).toBe("a: 1");
    expect(splitFrontmatter("---\n---\nbody")).toEqual({ yaml: "", body: "body", eol: "\n" });
  });
});

describe("parseFrontmatter", () => {
  it("reads properties of every YAML type", () => {
    const parsed = parseFrontmatter(
      "---\nn: 3\nok: true\nlist:\n  - x\n  - y\nnested:\n  k: v\nd: 2026-10-21\nnone:\n---\nbody",
    );
    expect(parsed.properties).toMatchObject({
      n: 3,
      ok: true,
      list: ["x", "y"],
      nested: { k: "v" },
      none: null,
    });
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.body).toBe("body");
  });

  it("never throws on bad YAML", () => {
    const parsed = parseFrontmatter("---\na: [unclosed\n---\nbody");
    expect(parsed.error).toBeTruthy();
    expect(parsed.properties).toEqual({});
    expect(parseFrontmatter("---\n- a\n- b\n---\nx").error).toMatch(/map/);
  });

  it("reports no frontmatter", () => {
    expect(parseFrontmatter("hello")).toEqual({
      properties: {},
      body: "hello",
      hasFrontmatter: false,
    });
  });
});

describe("setProperty / removeProperty", () => {
  it("changes one property and keeps comments and the other lines", () => {
    const out = setProperty(note, "status", "done");
    expect(out).toContain("# keep me");
    expect(out).toContain("tags: [a, b]");
    expect(out.endsWith("---\n# Body\n")).toBe(true);
    expect(parseFrontmatter(out).properties.status).toBe("done");
  });

  it("adds properties, creating the block when the note has none", () => {
    expect(setProperty("# Body\n", "status", "new")).toBe("---\nstatus: new\n---\n# Body\n");
    expect(parseFrontmatter(setProperty(note, "due", ["x", "y"])).properties.due).toEqual([
      "x",
      "y",
    ]);
  });

  it("quotes values that would otherwise change type", () => {
    expect(parseFrontmatter(setProperty("body", "v", "true")).properties.v).toBe("true");
    expect(parseFrontmatter(setProperty("body", "v", "a: b")).properties.v).toBe("a: b");
  });

  it("keeps CRLF and a BOM", () => {
    const out = setProperty("\uFEFF---\r\na: 1\r\n---\r\nbody\r\n", "b", 2);
    expect(out).toBe("\uFEFF---\r\na: 1\r\nb: 2\r\n---\r\nbody\r\n");
  });

  it("removes a property and drops an empty block", () => {
    expect(removeProperty("---\na: 1\nb: 2\n---\nx", "a")).toBe("---\nb: 2\n---\nx");
    expect(removeProperty("---\na: 1\n---\nx", "a")).toBe("x");
    expect(removeProperty("x", "a")).toBe("x");
  });

  it("refuses to rewrite broken frontmatter", () => {
    expect(() => setProperty("---\na: [x\n---\nb", "k", 1)).toThrow(FrontmatterError);
  });
});

describe("propertyTags", () => {
  it("reads lists, comma lists and space lists, dropping # and duplicates", () => {
    expect(propertyTags({ tags: ["#a", "b/c", "a"] })).toEqual(["a", "b/c"]);
    expect(propertyTags({ tags: "x, y z" })).toEqual(["x", "y", "z"]);
    expect(propertyTags({ tag: "solo" })).toEqual(["solo"]);
    expect(propertyTags({ tags: 5 })).toEqual([]);
  });
});
