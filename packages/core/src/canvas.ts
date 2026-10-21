/**
 * JSON Canvas 1.0 (https://jsoncanvas.org), the format Obsidian uses for .canvas files.
 * Unknown properties are kept on nodes, edges and the root so files written by
 * Obsidian or other tools round-trip without losing data.
 */

export type CanvasColor = string; // "1"–"6" preset or "#RRGGBB"
export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEnd = "none" | "arrow";

interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  [extra: string]: unknown;
}

export interface TextNode extends NodeBase {
  type: "text";
  text: string;
}

export interface FileNode extends NodeBase {
  type: "file";
  file: string;
  subpath?: string;
}

export interface LinkNode extends NodeBase {
  type: "link";
  url: string;
}

export interface GroupNode extends NodeBase {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
}

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: CanvasEnd;
  color?: CanvasColor;
  label?: string;
  [extra: string]: unknown;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [extra: string]: unknown;
}

export class CanvasParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasParseError";
  }
}

const NODE_TYPES = new Set(["text", "file", "link", "group"]);
const SIDES = new Set(["top", "right", "bottom", "left"]);

/** Parses canvas JSON. An empty file is an empty canvas; nodes or edges that are malformed are dropped. */
export function parseCanvas(source: string): CanvasData {
  if (source.trim() === "") return { nodes: [], edges: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err) {
    throw new CanvasParseError(`Invalid canvas JSON: ${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new CanvasParseError("Canvas root must be an object");

  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).filter(isValidNode) as CanvasNode[];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).filter(
    (e): e is CanvasEdge => isValidEdge(e) && ids.has(e.fromNode) && ids.has(e.toNode),
  );
  return { ...raw, nodes, edges };
}

/** Serializes with tab indentation, matching Obsidian's own output. */
export function serializeCanvas(canvas: CanvasData): string {
  return JSON.stringify(canvas, null, "\t");
}

/** Random 16-hex-digit id, the shape Obsidian uses. */
export function canvasId(): string {
  let id = "";
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/** Vault paths referenced by file nodes. */
export function canvasFileRefs(canvas: CanvasData): string[] {
  return canvas.nodes.filter((n): n is FileNode => n.type === "file").map((n) => n.file);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidNode(v: unknown): boolean {
  if (!isObject(v) || typeof v.id !== "string" || !NODE_TYPES.has(v.type as string)) return false;
  if (![v.x, v.y, v.width, v.height].every((n) => typeof n === "number" && Number.isFinite(n)))
    return false;
  if (v.type === "text") return typeof v.text === "string";
  if (v.type === "file") return typeof v.file === "string";
  if (v.type === "link") return typeof v.url === "string";
  return true;
}

function isValidEdge(v: unknown): v is CanvasEdge {
  if (!isObject(v) || typeof v.id !== "string") return false;
  if (typeof v.fromNode !== "string" || typeof v.toNode !== "string") return false;
  for (const side of [v.fromSide, v.toSide]) {
    if (side !== undefined && !SIDES.has(side as string)) return false;
  }
  return true;
}
