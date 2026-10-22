import { z } from "zod";
import {
  BASE_EXTENSION,
  BaseError,
  DEFAULT_MAX_FILE_BYTES,
  DOCUMENT_TYPES,
  MAX_CHUNKED_FILE_BYTES,
  MEDIA_TYPES,
  AppError,
  fileExtension,
  fileKind,
  parseBase,
  updateBaseSource,
  type BaseFile,
  type BaseFilter,
} from "@palimvo/core";
import { cleanPath, invalid, mcpTool, pathArg, readableIn, recorder } from "./shared.ts";

/** Most notes a graph answer lists; the best connected ones win when a vault has more. */
const MAX_GRAPH_NODES = 2000;

export const createFolder = mcpTool({
  name: "create_folder",
  tier: "advanced",
  scope: "vault",
  permission: "note.write",
  writes: true,
  input: z.object({ path: pathArg("Folder to create, e.g. `Projects/2026`.") }),
  description:
    "Create an empty folder (and the folders above it). Notes create their folders themselves; use this for an empty one. Example: {path:'Projects/2026'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    if (path === "") throw invalid("Give a folder path.");
    ctx.access.requireTree("note.write", ctx.vault, path);
    return ctx.deps.vaults.createFolder(ctx.vault, path, (placeholder) =>
      recorder(ctx)([placeholder]),
    );
  },
});

export const getGraph = mcpTool({
  name: "get_graph",
  tier: "advanced",
  scope: "vault",
  permission: "note.read",
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_GRAPH_NODES)
      .optional()
      .describe(
        `Most notes to list, best connected first. Default 300, at most ${MAX_GRAPH_NODES}.`,
      ),
  }),
  description:
    "The link graph of a vault: notes, canvases and databases as nodes and the links between them as edges, plus links whose target is missing. Example: {limit:100}.",
  handler: async (args, ctx) => {
    const guard = readableIn(ctx);
    const graph = await ctx.deps.indexes.links.graph(ctx.vault);
    const nodes = graph.nodes.filter((n) => guard.can(n.path));
    const edges = graph.edges.filter((e) => guard.can(e.from) && guard.can(e.to));
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const limit = args.limit ?? 300;
    const kept = [...nodes]
      .sort(
        (a, b) =>
          (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) || a.path.localeCompare(b.path),
      )
      .slice(0, limit);
    const shown = new Set(kept.map((n) => n.path));
    return {
      nodes: kept,
      edges: edges.filter((e) => shown.has(e.from) && shown.has(e.to)),
      unresolved: graph.unresolved.filter((u) => shown.has(u.from)),
      total: nodes.length,
      ...(nodes.length > kept.length ? { truncated: true } : {}),
    };
  },
});

export const createCheckpoint = mcpTool({
  name: "create_checkpoint",
  tier: "advanced",
  scope: "vault",
  permission: "note.write",
  writes: true,
  input: z.object({
    tag: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("A name for it, e.g. `before-reorg`. Optional; must be unused."),
  }),
  description:
    "Save a checkpoint of the whole vault now, so you or a person can compare with it or return to it later. Your `reason` is its description. Example: {tag:'before-reorg', reason:'Before moving the project notes'}.",
  handler: async (args, ctx) => {
    const commit = await ctx.deps.history.checkpoint(ctx.vault, {
      message: ctx.note.reason ?? "Checkpoint",
      tag: args.tag,
      author: ctx.author,
    });
    return { id: commit.id.slice(0, 12), date: commit.date, tags: commit.tags };
  },
});

export const restoreVersion = mcpTool({
  name: "restore_version",
  tier: "advanced",
  scope: "vault",
  // Restoring one file is writing it again with older text, which is what `note.write` allows.
  // The whole-vault restore of people with `history.restore` is not offered to AI clients.
  permission: ["note.write", "history.view"],
  writes: true,
  input: z.object({
    path: pathArg("The file to bring back."),
    commit: z.string().min(4).max(64).describe("An id from get_history or a checkpoint."),
    from: z
      .string()
      .optional()
      .describe("The file's path in that change, if it was named differently then."),
  }),
  description:
    "Put one file back to how it was in an earlier change (a new change on top; nothing is lost). Find the id with get_history. Example: {path:'Plan.md', commit:'3fa9c1d2e4b5'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    const from = args.from ? cleanPath(args.from) : path;
    ctx.access.requireTree("note.write", ctx.vault, path);
    const guard = readableIn(ctx);
    guard.require(path);
    guard.require(from);
    const bytes = await ctx.deps.history.blob(ctx.vault, args.commit, from);
    const written = await ctx.deps.vaults.writeBytes(ctx.vault, path, bytes, {
      onWritten: (w) => recorder(ctx)([w.path]),
    });
    return { path: written.path, version: written.version, restored_from: args.commit };
  },
});

const noQuotes = (s: string) => !/["\\\n\r]/.test(s);

export const createBase = mcpTool({
  name: "create_base",
  tier: "advanced",
  scope: "vault",
  permission: "note.write",
  writes: true,
  input: z.object({
    path: pathArg("New database, e.g. `Tasks.base`. `.base` is added when there is no extension."),
    folder: z.string().optional().describe("Only notes in this folder (and below)."),
    tags: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe("Only notes with any of these tags."),
    columns: z
      .array(z.string().min(1))
      .max(30)
      .optional()
      .describe("Columns in order: note properties, or `file.name`, `file.tags`, `file.mtime`."),
    view: z.enum(["table", "cards"]).optional().describe("Default table."),
  }),
  description:
    "Create a database (.base): its rows are the notes in a folder or with tags, its columns their properties. Fill it by setting properties with set_note_property, read it with query_base. Example: {path:'Tasks.base', folder:'Tasks', columns:['file.name','status','due']}.",
  handler: async (args, ctx) => {
    const named = cleanPath(args.path);
    const path = fileExtension(named) === "" ? `${named}${BASE_EXTENSION}` : named;
    if (fileKind(path) !== "base") throw invalid(`${path} must end in ${BASE_EXTENSION}.`);
    ctx.access.requireTree("note.write", ctx.vault, path);
    const parts: BaseFilter[] = [];
    if (args.folder !== undefined) {
      const folder = cleanPath(args.folder);
      if (!noQuotes(folder)) throw invalid("folder must not contain quotes or backslashes.");
      if (folder !== "") parts.push(`file.inFolder("${folder}")`);
    }
    const tags = (args.tags ?? []).map((t) => t.replace(/^#/, "").trim()).filter(Boolean);
    if (tags.some((t) => !noQuotes(t)))
      throw invalid("tags must not contain quotes or backslashes.");
    if (tags.length > 0) parts.push({ or: tags.map((t) => `file.hasTag("${t}")`) });
    const base: BaseFile = {
      ...(parts.length === 0
        ? {}
        : { filters: parts.length === 1 ? (parts[0] as BaseFilter) : { and: parts } }),
      views: [
        {
          type: args.view ?? "table",
          name: args.view === "cards" ? "Cards" : "Table",
          order: args.columns ?? ["file.name", "file.tags", "file.mtime"],
        },
      ],
    };
    const source = updateBaseSource("", base);
    try {
      parseBase(source);
    } catch (err) {
      if (err instanceof BaseError) throw invalid(err.message);
      throw err;
    }
    try {
      const written = await ctx.deps.vaults.writeFile(ctx.vault, path, source, {
        baseVersion: null,
        onWritten: (w) => recorder(ctx)([w.path]),
      });
      return { path: written.path, version: written.version };
    } catch (err) {
      if (err instanceof AppError && err.code === "version_conflict")
        throw new AppError(
          "already_exists",
          undefined,
          { path },
          { message: `${path} already exists. Use update_note to change it.` },
        );
      throw err;
    }
  },
});

export const listFileTypes = mcpTool({
  name: "list_file_types",
  tier: "advanced",
  scope: "vault",
  permission: [],
  input: z.object({}),
  description:
    "The kinds of files this vault accepts with upload_file and their size limits: notes, canvases and databases (create_note), media, documents and anything a plugin adds. Example: {}.",
  handler: async (_args, ctx) => {
    const byKind: Record<string, string[]> = { image: [], audio: [], video: [] };
    for (const [ext, m] of Object.entries(MEDIA_TYPES)) byKind[m.kind]?.push(ext);
    // Plugin-declared types join here once the plugin platform supplies them.
    const plugins = ctx.deps.plugins?.enabled(ctx.vault) ?? [];
    return {
      notes: ["md", "canvas", "base"],
      media: byKind,
      documents: Object.keys(DOCUMENT_TYPES),
      max_bytes: DEFAULT_MAX_FILE_BYTES,
      max_bytes_chunked: MAX_CHUNKED_FILE_BYTES,
      plugins: plugins.map((p) => p.id),
    };
  },
});
