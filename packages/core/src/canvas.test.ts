import { describe, expect, it } from "vitest";
import {
  CanvasParseError,
  canvasFileRefs,
  canvasId,
  parseCanvas,
  serializeCanvas,
} from "./canvas.ts";

const obsidianCanvas = {
  nodes: [
    { id: "a1", type: "text", text: "# Hello", x: 0, y: 0, width: 250, height: 60, color: "4" },
    { id: "b2", type: "file", file: "notes/Idea.md", x: 300, y: 0, width: 400, height: 400 },
    {
      id: "c3",
      type: "link",
      url: "https://jsoncanvas.org",
      x: 0,
      y: 200,
      width: 400,
      height: 300,
    },
    {
      id: "g4",
      type: "group",
      label: "Group",
      x: -20,
      y: -20,
      width: 800,
      height: 600,
      customFlag: true,
    },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "a1",
      fromSide: "right",
      toNode: "b2",
      toSide: "left",
      toEnd: "arrow",
      label: "uses",
    },
  ],
  metadata: { version: "1.0" },
};

describe("parseCanvas", () => {
  it("round-trips Obsidian canvases, including unknown fields", () => {
    const parsed = parseCanvas(JSON.stringify(obsidianCanvas));
    expect(JSON.parse(serializeCanvas(parsed))).toEqual(obsidianCanvas);
  });

  it("treats an empty file as an empty canvas", () => {
    expect(parseCanvas("  ")).toEqual({ nodes: [], edges: [] });
  });

  it("drops malformed nodes and edges that point at missing nodes", () => {
    const parsed = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "ok", type: "text", text: "x", x: 0, y: 0, width: 1, height: 1 },
          { id: "bad", type: "text", x: 0, y: 0, width: 1, height: 1 },
          { id: "weird", type: "video", x: 0, y: 0, width: 1, height: 1 },
        ],
        edges: [
          { id: "e1", fromNode: "ok", toNode: "bad" },
          { id: "e2", fromNode: "ok", toNode: "ok", fromSide: "middle" },
        ],
      }),
    );
    expect(parsed.nodes.map((n) => n.id)).toEqual(["ok"]);
    expect(parsed.edges).toEqual([]);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseCanvas("{nope")).toThrow(CanvasParseError);
    expect(() => parseCanvas("[]")).toThrow(CanvasParseError);
  });
});

describe("helpers", () => {
  it("serializes with tabs", () => {
    expect(serializeCanvas({ nodes: [], edges: [] })).toBe('{\n\t"nodes": [],\n\t"edges": []\n}');
  });

  it("lists file references", () => {
    expect(canvasFileRefs(parseCanvas(JSON.stringify(obsidianCanvas)))).toEqual(["notes/Idea.md"]);
  });

  it("creates 16-char hex ids", () => {
    expect(canvasId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
