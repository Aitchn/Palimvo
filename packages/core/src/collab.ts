import * as Y from "yjs";
import {
  parseCanvas,
  serializeCanvas,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
} from "./canvas.ts";
import { fileKind } from "./paths.ts";

/**
 * Shared Yjs document layout for collaboratively edited files.
 *
 * - Markdown: one Y.Text, so concurrent typing merges character by character.
 * - Canvas: nodes and edges keyed by id (concurrent edits to different cards
 *   merge; the same card is last-writer-wins), an order array for z-order,
 *   and the remaining root fields.
 */
export type CollabKind = "markdown" | "canvas";

const TEXT = "markdown";
const NODES = "canvas.nodes";
const EDGES = "canvas.edges";
const NODE_ORDER = "canvas.nodeOrder";
const EDGE_ORDER = "canvas.edgeOrder";
const META = "canvas.meta";

export function collabKind(path: string): CollabKind | null {
  const kind = fileKind(path);
  return kind === "markdown" || kind === "canvas" ? kind : null;
}

export function markdownText(doc: Y.Doc): Y.Text {
  return doc.getText(TEXT);
}

/** Current file content represented by the document. */
export function docContent(doc: Y.Doc, kind: CollabKind): string {
  return kind === "markdown" ? markdownText(doc).toString() : serializeCanvas(readCanvas(doc));
}

/**
 * Makes the document represent `content` with the smallest change, so edits
 * that other clients are making elsewhere in the file survive. Throws on a
 * canvas that cannot be parsed, leaving the document untouched.
 */
export function applyContent(
  doc: Y.Doc,
  kind: CollabKind,
  content: string,
  origin?: unknown,
): void {
  if (kind === "markdown") {
    doc.transact(() => applyTextDiff(markdownText(doc), content), origin);
  } else {
    const canvas = parseCanvas(content);
    doc.transact(() => writeCanvas(doc, canvas), origin);
  }
}

/** Replaces the differing middle of a Y.Text (common prefix and suffix are kept). */
export function applyTextDiff(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  let start = 0;
  const max = Math.min(current.length, next.length);
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  ) {
    end++;
  }
  const removed = current.length - start - end;
  if (removed > 0) text.delete(start, removed);
  const inserted = next.slice(start, next.length - end);
  if (inserted) text.insert(start, inserted);
}

export function readCanvas(doc: Y.Doc): CanvasData {
  const nodes = doc.getMap<CanvasNode>(NODES);
  const edges = doc.getMap<CanvasEdge>(EDGES);
  const meta = doc.getMap<unknown>(META);
  const orderedNodes = ordered(doc.getArray<string>(NODE_ORDER), nodes);
  const nodeIds = new Set(orderedNodes.map((n) => n.id));
  return {
    ...Object.fromEntries(meta.entries()),
    nodes: orderedNodes,
    // An edge can outlive a concurrently deleted node; drop it rather than write a dangling edge.
    edges: ordered(doc.getArray<string>(EDGE_ORDER), edges).filter(
      (e) => nodeIds.has(e.fromNode) && nodeIds.has(e.toNode),
    ),
  };
}

/** Diff-applies a canvas: only changed, added and removed nodes/edges/fields are touched. Call inside a transaction. */
export function writeCanvas(doc: Y.Doc, canvas: CanvasData): void {
  const { nodes, edges, ...rest } = canvas;
  syncById(doc.getMap<CanvasNode>(NODES), doc.getArray<string>(NODE_ORDER), nodes);
  syncById(doc.getMap<CanvasEdge>(EDGES), doc.getArray<string>(EDGE_ORDER), edges);
  const meta = doc.getMap<unknown>(META);
  for (const key of [...meta.keys()]) if (!(key in rest)) meta.delete(key);
  for (const [key, value] of Object.entries(rest)) {
    if (!sameJson(meta.get(key), value)) meta.set(key, value);
  }
}

function ordered<T extends { id: string }>(order: Y.Array<string>, items: Y.Map<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of order.toArray()) {
    const item = items.get(id);
    if (item && !seen.has(id)) {
      seen.add(id);
      out.push(item);
    }
  }
  // Items whose order entry was lost to a concurrent edit still show up, at the end.
  for (const [id, item] of items.entries()) if (!seen.has(id)) out.push(item);
  return out;
}

function syncById<T extends { id: string }>(
  map: Y.Map<T>,
  order: Y.Array<string>,
  items: T[],
): void {
  const wanted = new Map(items.map((item) => [item.id, item]));
  for (const id of [...map.keys()]) if (!wanted.has(id)) map.delete(id);
  for (const [id, item] of wanted) if (!sameJson(map.get(id), item)) map.set(id, item);

  const current = order.toArray();
  const next = items.map((item) => item.id);
  if (current.length === next.length && current.every((id, i) => id === next[i])) return;
  // Order changes are rare (add, delete, bring-to-front); rewrite the array.
  order.delete(0, order.length);
  order.insert(0, next);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
