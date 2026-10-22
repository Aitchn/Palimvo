import { z } from "zod";
import {
  CanvasParseError,
  canvasId,
  fileKind,
  parseCanvas,
  serializeCanvas,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
} from "@palimvo/core";
import { cleanPath, invalid, modifyText, pathArg, readableIn, mcpTool } from "./shared.ts";

const SIDE = z.enum(["top", "right", "bottom", "left"]);
const END = z.enum(["none", "arrow"]);
const COLOR = z
  .string()
  .regex(/^([1-6]|#[0-9a-fA-F]{6})$/)
  .describe('"1"-"6" or "#RRGGBB".');
const NODE_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const GAP = 40;

const addNode = z.object({
  op: z.literal("add_node"),
  type: z.enum(["text", "file", "link", "group"]),
  id: NODE_ID.optional().describe("Your own id, so later operations in this call can refer to it."),
  text: z.string().optional().describe("For text nodes (Markdown)."),
  file: z.string().optional().describe("For file nodes: vault path of the note or media."),
  url: z.string().optional().describe("For link nodes."),
  label: z.string().optional().describe("For group nodes."),
  x: z.number().optional().describe("Default: below everything else."),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  color: COLOR.optional(),
});
const updateNode = z.object({
  op: z.literal("update_node"),
  id: z.string(),
  text: z.string().optional(),
  file: z.string().optional(),
  url: z.string().optional(),
  label: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  color: COLOR.nullable().optional().describe("null removes the color."),
});
const addEdge = z.object({
  op: z.literal("add_edge"),
  id: NODE_ID.optional(),
  from: z.string().describe("Node id."),
  to: z.string().describe("Node id."),
  from_side: SIDE.optional(),
  to_side: SIDE.optional(),
  from_end: END.optional(),
  to_end: END.optional().describe("Default arrow."),
  label: z.string().optional(),
  color: COLOR.optional(),
});
const updateEdge = z.object({
  op: z.literal("update_edge"),
  id: z.string(),
  label: z.string().nullable().optional().describe("null removes the label."),
  color: COLOR.nullable().optional(),
  from_side: SIDE.optional(),
  to_side: SIDE.optional(),
  from_end: END.optional(),
  to_end: END.optional(),
});
const remove = z.object({
  op: z.literal("remove"),
  ids: z.array(z.string()).min(1).describe("Nodes (their edges go too) and edges."),
});
const operation = z.discriminatedUnion("op", [addNode, updateNode, addEdge, updateEdge, remove]);
type Operation = z.infer<typeof operation>;

const DEFAULT_SIZE: Record<string, [number, number]> = {
  text: [260, 120],
  file: [400, 300],
  link: [400, 200],
  group: [600, 400],
};

function loadCanvas(source: string, path: string): CanvasData {
  try {
    return parseCanvas(source);
  } catch (err) {
    if (err instanceof CanvasParseError)
      throw invalid(`${path} is not a valid canvas: ${err.message}`);
    throw err;
  }
}

function freshId(taken: Set<string>, wanted?: string): string {
  if (wanted !== undefined) {
    if (taken.has(wanted)) throw invalid(`The id "${wanted}" is already used on this canvas.`);
    taken.add(wanted);
    return wanted;
  }
  for (;;) {
    const id = canvasId();
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

function node(canvas: CanvasData, id: string, op: string): CanvasNode {
  const found = canvas.nodes.find((n) => n.id === id);
  if (!found) throw invalid(`${op}: there is no node "${id}". Read the canvas again.`);
  return found;
}

/** Where a node without a position goes: below the lowest existing node, aligned with the left edge. */
function nextFree(canvas: CanvasData): { x: number; y: number } {
  if (canvas.nodes.length === 0) return { x: 0, y: 0 };
  const x = Math.min(...canvas.nodes.map((n) => n.x));
  const y = Math.max(...canvas.nodes.map((n) => n.y + n.height));
  return { x, y: y + GAP };
}

/** Applies the operations in order; throws on the first bad one, so a failed call changes nothing. */
function apply(
  canvas: CanvasData,
  ops: readonly Operation[],
  added: { id: string; kind: "node" | "edge" }[],
): void {
  const taken = new Set([...canvas.nodes, ...canvas.edges].map((o) => o.id));
  ops.forEach((op, i) => {
    const where = `operations[${i}] (${op.op})`;
    switch (op.op) {
      case "add_node": {
        const field = { text: op.text, file: op.file, url: op.url }[op.type as "text"];
        if (op.type !== "group" && (field === undefined || field === ""))
          throw invalid(
            `${where}: a ${op.type} node needs ${op.type === "text" ? "text" : op.type === "file" ? "file" : "url"}.`,
          );
        const [w, h] = DEFAULT_SIZE[op.type]!;
        const at = nextFree(canvas);
        const base = {
          id: freshId(taken, op.id),
          x: op.x ?? at.x,
          y: op.y ?? at.y,
          width: op.width ?? w,
          height: op.height ?? h,
          ...(op.color ? { color: op.color } : {}),
        };
        const made: CanvasNode =
          op.type === "text"
            ? { ...base, type: "text", text: op.text ?? "" }
            : op.type === "file"
              ? { ...base, type: "file", file: cleanPath(op.file!) }
              : op.type === "link"
                ? { ...base, type: "link", url: op.url! }
                : { ...base, type: "group", ...(op.label ? { label: op.label } : {}) };
        canvas.nodes.push(made);
        added.push({ id: made.id, kind: "node" });
        break;
      }
      case "update_node": {
        const n = node(canvas, op.id, where);
        const set = (key: string, value: unknown) => {
          if (value === undefined) return;
          if (value === null) delete n[key];
          else n[key] = value;
        };
        if (op.text !== undefined && n.type !== "text")
          throw invalid(`${where}: "${op.id}" is not a text node.`);
        if (op.file !== undefined && n.type !== "file")
          throw invalid(`${where}: "${op.id}" is not a file node.`);
        if (op.url !== undefined && n.type !== "link")
          throw invalid(`${where}: "${op.id}" is not a link node.`);
        if (op.label !== undefined && n.type !== "group")
          throw invalid(`${where}: "${op.id}" is not a group.`);
        set("text", op.text);
        set("file", op.file === undefined ? undefined : cleanPath(op.file));
        set("url", op.url);
        set("label", op.label);
        set("x", op.x);
        set("y", op.y);
        set("width", op.width);
        set("height", op.height);
        set("color", op.color);
        break;
      }
      case "add_edge": {
        node(canvas, op.from, where);
        node(canvas, op.to, where);
        const edge: CanvasEdge = {
          id: freshId(taken, op.id),
          fromNode: op.from,
          toNode: op.to,
          ...(op.from_side ? { fromSide: op.from_side } : {}),
          ...(op.to_side ? { toSide: op.to_side } : {}),
          ...(op.from_end ? { fromEnd: op.from_end } : {}),
          ...(op.to_end ? { toEnd: op.to_end } : {}),
          ...(op.label ? { label: op.label } : {}),
          ...(op.color ? { color: op.color } : {}),
        };
        canvas.edges.push(edge);
        added.push({ id: edge.id, kind: "edge" });
        break;
      }
      case "update_edge": {
        const e = canvas.edges.find((x) => x.id === op.id);
        if (!e) throw invalid(`${where}: there is no edge "${op.id}". Read the canvas again.`);
        const set = (key: string, value: unknown) => {
          if (value === undefined) return;
          if (value === null) delete e[key];
          else e[key] = value;
        };
        set("label", op.label);
        set("color", op.color);
        set("fromSide", op.from_side);
        set("toSide", op.to_side);
        set("fromEnd", op.from_end);
        set("toEnd", op.to_end);
        break;
      }
      case "remove": {
        const ids = new Set(op.ids);
        const known = new Set([...canvas.nodes, ...canvas.edges].map((o) => o.id));
        const missing = op.ids.filter((id) => !known.has(id));
        if (missing.length > 0)
          throw invalid(`${where}: nothing with id ${missing.map((m) => `"${m}"`).join(", ")}.`);
        canvas.nodes = canvas.nodes.filter((n) => !ids.has(n.id));
        canvas.edges = canvas.edges.filter(
          (e) => !ids.has(e.id) && !ids.has(e.fromNode) && !ids.has(e.toNode),
        );
        break;
      }
    }
  });
}

export const readCanvas = mcpTool({
  name: "read_canvas",
  tier: "native",
  scope: "vault",
  permission: "note.read",
  input: z.object({ path: pathArg("A .canvas file.") }),
  description:
    "Read a canvas as nodes (text, file, link, group; with position and size) and edges. Example: {path:'Map.canvas'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    readableIn(ctx).require(path);
    if (fileKind(path) !== "canvas") throw invalid(`${path} is not a .canvas file.`);
    const file = await ctx.deps.vaults.readFile(ctx.vault, path);
    const canvas = loadCanvas(file.content, path);
    return { path, version: file.version, nodes: canvas.nodes, edges: canvas.edges };
  },
});

export const editCanvas = mcpTool({
  name: "edit_canvas",
  tier: "native",
  scope: "vault",
  permission: "note.write",
  writes: true,
  input: z.object({
    path: pathArg("An existing .canvas file (create_note makes a new one)."),
    operations: z
      .array(operation)
      .min(1)
      .max(200)
      .describe(
        "Applied in order, all or none: add_node, update_node, add_edge, update_edge, remove.",
      ),
  }),
  description:
    "Change a canvas with several operations at once. Give new nodes your own id to connect them in the same call. Example: {path:'Map.canvas', operations:[{op:'add_node',type:'text',id:'a',text:'Idea'},{op:'add_node',type:'file',id:'b',file:'Plan.md'},{op:'add_edge',from:'a',to:'b',label:'see'}]}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    if (fileKind(path) !== "canvas") throw invalid(`${path} is not a .canvas file.`);
    ctx.access.requireTree("note.write", ctx.vault, path);
    let added: { id: string; kind: "node" | "edge" }[] = [];
    let counts = { nodes: 0, edges: 0 };
    const result = await modifyText(ctx, path, (current) => {
      // A retry after a concurrent change starts over on the newest canvas.
      added = [];
      const canvas = loadCanvas(current, path);
      apply(canvas, args.operations, added);
      counts = { nodes: canvas.nodes.length, edges: canvas.edges.length };
      return serializeCanvas(canvas);
    });
    return {
      path,
      version: result.version,
      changed: result.changed,
      added: added.map((a) => ({ id: a.id, kind: a.kind })),
      ...counts,
    };
  },
});
