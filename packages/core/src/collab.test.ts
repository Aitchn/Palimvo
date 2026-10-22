import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyContent, applyTextDiff, docContent, markdownText, readCanvas } from "./collab.ts";

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe("markdown documents", () => {
  it("round-trips content", () => {
    const doc = new Y.Doc();
    applyContent(doc, "markdown", "# Hello\n");
    expect(docContent(doc, "markdown")).toBe("# Hello\n");
  });

  it("applies external content as a minimal diff that merges with concurrent typing", () => {
    const a = new Y.Doc();
    applyContent(a, "markdown", "alpha\nbeta\ngamma\n");
    const b = new Y.Doc();
    sync(a, b);

    // A person types at the end while an AI rewrites the first line.
    markdownText(a).insert(markdownText(a).length, "delta\n");
    applyContent(b, "markdown", "ALPHA\nbeta\ngamma\n");
    sync(a, b);

    expect(docContent(a, "markdown")).toBe("ALPHA\nbeta\ngamma\ndelta\n");
    expect(docContent(b, "markdown")).toBe(docContent(a, "markdown"));
  });

  it("applyTextDiff handles insertions, deletions and replacements", () => {
    const doc = new Y.Doc();
    const text = markdownText(doc);
    for (const next of ["abc", "abXc", "Xc", "", "hello world", "hello brave world", "world"]) {
      applyTextDiff(text, next);
      expect(text.toString()).toBe(next);
    }
  });
});

describe("canvas documents", () => {
  const base = {
    nodes: [
      { id: "g", type: "group", x: 0, y: 0, width: 500, height: 500, label: "G" },
      { id: "a", type: "text", text: "A", x: 10, y: 10, width: 100, height: 50 },
      { id: "b", type: "text", text: "B", x: 200, y: 10, width: 100, height: 50 },
    ],
    edges: [{ id: "e", fromNode: "a", toNode: "b" }],
    extra: { keep: true },
  };

  it("round-trips a canvas, including order and unknown fields", () => {
    const doc = new Y.Doc();
    applyContent(doc, "canvas", JSON.stringify(base));
    expect(readCanvas(doc)).toEqual(base);
  });

  it("merges concurrent edits to different cards", () => {
    const a = new Y.Doc();
    applyContent(a, "canvas", JSON.stringify(base));
    const b = new Y.Doc();
    sync(a, b);

    const fromA = readCanvas(a);
    fromA.nodes[1] = { ...fromA.nodes[1]!, x: 99 } as never;
    applyContent(a, "canvas", JSON.stringify(fromA));

    const fromB = readCanvas(b);
    fromB.nodes[2] = { ...fromB.nodes[2]!, text: "B edited" } as never;
    fromB.nodes.push({ id: "c", type: "text", text: "new", x: 0, y: 300, width: 100, height: 50 });
    applyContent(b, "canvas", JSON.stringify(fromB));

    sync(a, b);
    const merged = readCanvas(a);
    expect(merged).toEqual(readCanvas(b));
    expect(merged.nodes.find((n) => n.id === "a")?.x).toBe(99);
    expect(merged.nodes.find((n) => n.id === "b")).toMatchObject({ text: "B edited" });
    expect(merged.nodes.map((n) => n.id)).toContain("c");
  });

  it("drops edges whose node was deleted concurrently", () => {
    const a = new Y.Doc();
    applyContent(a, "canvas", JSON.stringify(base));
    const b = new Y.Doc();
    sync(a, b);

    applyContent(
      a,
      "canvas",
      JSON.stringify({ ...base, nodes: base.nodes.filter((n) => n.id !== "b"), edges: [] }),
    );
    applyContent(
      b,
      "canvas",
      JSON.stringify({ ...base, edges: [...base.edges, { id: "e2", fromNode: "b", toNode: "a" }] }),
    );
    sync(a, b);

    expect(readCanvas(a).edges).toEqual([]);
  });

  it("leaves the document untouched when the canvas cannot be parsed", () => {
    const doc = new Y.Doc();
    applyContent(doc, "canvas", JSON.stringify(base));
    expect(() => applyContent(doc, "canvas", "{broken")).toThrow();
    expect(readCanvas(doc)).toEqual(base);
  });
});
