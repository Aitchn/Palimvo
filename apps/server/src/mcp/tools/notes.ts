import { z } from "zod";
import {
  AppError,
  BaseError,
  CanvasParseError,
  NEW_BASE,
  fileExtension,
  fileKind,
  isTextDocument,
  noteProperties,
  parseBase,
  parseCanvas,
  setNoteProperty,
  type TreeNode,
} from "@palimvo/core";
import {
  cleanPath,
  invalid,
  modifyText,
  pathArg,
  readableIn,
  recorder,
  mcpTool,
} from "./shared.ts";

const EMPTY_CANVAS = '{\n\t"nodes": [],\n\t"edges": []\n}';
const DEFAULT_MAX_CHARS = 100_000;

/** The folder named by `path` in the tree ("" is the vault root). */
function folderAt(tree: readonly TreeNode[], path: string): readonly TreeNode[] | undefined {
  let level = tree;
  if (path === "") return level;
  for (const part of path.split("/")) {
    const next = level.find(
      (n) => n.type === "folder" && n.name.toLowerCase() === part.toLowerCase(),
    );
    if (!next?.children) return undefined;
    level = next.children;
  }
  return level;
}

function flatten(nodes: readonly TreeNode[], out: { path: string; kind: string | undefined }[]) {
  for (const n of nodes) {
    if (n.type === "file") out.push({ path: n.path, kind: n.kind });
    else if (n.children) flatten(n.children, out);
  }
}

export const listFiles = mcpTool({
  name: "list_files",
  tier: "native",
  scope: "vault",
  permission: "note.read",
  input: z.object({
    folder: z.string().optional().describe("Folder to list; default the vault root."),
    recursive: z.boolean().optional().describe("List every file below it, as a flat list."),
    limit: z.number().int().min(1).max(2000).optional().describe("Default 200."),
  }),
  description:
    "List files and folders of a vault. Example: {folder:'Projects'} lists one level; {recursive:true} lists every file path.",
  handler: async (args, ctx) => {
    const folder = args.folder ? cleanPath(args.folder) : "";
    const level = folderAt(await ctx.deps.vaults.tree(ctx.vault), folder);
    if (!level) throw new AppError("not_found", undefined, { path: folder });
    const guard = readableIn(ctx);
    const limit = args.limit ?? 200;
    if (args.recursive) {
      const files: { path: string; kind: string | undefined }[] = [];
      flatten(level, files);
      const shown = files.filter((f) => guard.can(f.path));
      return {
        folder,
        total: shown.length,
        files: shown.slice(0, limit).map((f) => f.path),
        ...(shown.length > limit ? { truncated: true } : {}),
      };
    }
    // A folder is listed when anything readable is inside it (a folder-limited token sees only its folders).
    const hasReadable = (n: TreeNode): boolean => {
      if (!guard.limited) return true;
      if (n.type === "file") return guard.can(n.path);
      return (n.children ?? []).some(hasReadable);
    };
    const entries = level.filter(hasReadable);
    return {
      folder,
      total: entries.length,
      entries: entries
        .slice(0, limit)
        .map((n) =>
          n.type === "folder"
            ? { path: n.path, type: "folder" }
            : { path: n.path, type: "file", kind: n.kind },
        ),
      ...(entries.length > limit ? { truncated: true } : {}),
    };
  },
});

export const readNote = mcpTool({
  name: "read_note",
  tier: "native",
  scope: "vault",
  permission: "note.read",
  input: z.object({
    path: pathArg("Note, canvas (.canvas), database (.base) or text file."),
    max_chars: z.number().int().min(1000).max(1_000_000).optional().describe("Default 100000."),
  }),
  description:
    "Read a note, canvas, database or text file (txt, csv, json, yaml) as text, with its version. Markdown notes also return their properties. Binary files: use download_file. Example: {path:'Projects/Plan.md'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    readableIn(ctx).require(path);
    if (fileKind(path) === "other" && !isTextDocument(path))
      throw new AppError(
        "unsupported_type",
        undefined,
        { path },
        {
          message: `${path} is not a text file. Use download_file to get its bytes.`,
        },
      );
    const file = await ctx.deps.vaults.readFile(ctx.vault, path);
    const max = args.max_chars ?? DEFAULT_MAX_CHARS;
    const truncated = file.content.length > max;
    return {
      path: file.path,
      kind: fileKind(file.path),
      version: file.version,
      ...(fileKind(file.path) === "markdown" ? { properties: noteProperties(file.content) } : {}),
      content: truncated ? file.content.slice(0, max) : file.content,
      ...(truncated ? { truncated: true, length: file.content.length } : {}),
    };
  },
});

export const search = mcpTool({
  name: "search",
  tier: "native",
  scope: "vault",
  permission: "note.read",
  input: z.object({
    query: z.string().min(1).max(500).describe('Words that must all appear; "quote" a phrase.'),
    folder: z.string().optional().describe("Only below this folder."),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
    offset: z.number().int().min(0).optional(),
  }),
  description:
    "Full-text search over names and contents of notes, canvases and databases. Returns paths with the matching lines. Example: {query:'launch plan'}.",
  handler: async (args, ctx) => {
    const guard = readableIn(ctx);
    const page = await ctx.deps.indexes.search.search(ctx.vault, args.query, {
      limit: args.limit ?? 20,
      offset: args.offset ?? 0,
      ...(args.folder ? { folder: cleanPath(args.folder) } : {}),
      ...(guard.limited ? { include: guard.can } : {}),
    });
    return {
      total: page.total,
      offset: page.offset,
      hits: page.hits.map((h) => ({
        path: h.path,
        ...(h.titleMatch ? { name_match: true } : {}),
        ...(h.matches.length > 0 ? { matches: h.matches } : {}),
      })),
    };
  },
});

export const getBacklinks = mcpTool({
  name: "get_backlinks",
  tier: "native",
  scope: "vault",
  permission: "note.read",
  input: z.object({ path: pathArg() }),
  description:
    "Files that link to or embed a note, with the lines that do. Example: {path:'Projects/Plan.md'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    const guard = readableIn(ctx);
    guard.require(path);
    const links = await ctx.deps.indexes.links.backlinks(ctx.vault, path);
    return { path, backlinks: links.filter((l) => guard.can(l.path)) };
  },
});

/** Note, canvas and database files must hold valid content; other text is stored as given. */
function checkContent(path: string, content: string): void {
  const kind = fileKind(path);
  try {
    if (kind === "canvas") parseCanvas(content);
    else if (kind === "base") parseBase(content);
  } catch (err) {
    if (err instanceof CanvasParseError || err instanceof BaseError)
      throw invalid(`${path} would not be a valid ${kind}: ${err.message}`);
    throw err;
  }
}

export const createNote = mcpTool({
  name: "create_note",
  tier: "native",
  scope: "vault",
  permission: "note.write",
  writes: true,
  input: z.object({
    path: pathArg("New file, e.g. `Ideas/Rocket.md`. `.md` is added when there is no extension."),
    content: z.string().optional().describe("Text. Omit for an empty note, canvas or database."),
  }),
  description:
    "Create a note (or a .canvas / .base file) and any folders on its path. Fails if it already exists; use update_note to change it. Example: {path:'Ideas/Rocket.md', content:'# Rocket'}.",
  handler: async (args, ctx) => {
    const named = cleanPath(args.path);
    const path = fileExtension(named) === "" ? `${named}.md` : named;
    ctx.access.requireTree("note.write", ctx.vault, path);
    const kind = fileKind(path);
    const content =
      args.content ?? (kind === "canvas" ? EMPTY_CANVAS : kind === "base" ? NEW_BASE : "");
    checkContent(path, content);
    try {
      const written = await ctx.deps.vaults.writeFile(ctx.vault, path, content, {
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
          {
            message: `${path} already exists. Use update_note to change it.`,
          },
        );
      throw err;
    }
  },
});

const editSchema = z.object({
  find: z.string().min(1).describe("Exact text to replace (must occur once unless all is true)."),
  replace: z.string().describe("Replacement; empty deletes the text."),
  all: z.boolean().optional().describe("Replace every occurrence."),
});

function applyEdits(content: string, edits: readonly z.infer<typeof editSchema>[]): string {
  let text = content;
  edits.forEach((edit, i) => {
    const parts = text.split(edit.find);
    const count = parts.length - 1;
    if (count === 0)
      throw invalid(`edits[${i}]: the text to find was not found. Read the note again.`, {
        index: i,
      });
    if (count > 1 && !edit.all)
      throw invalid(
        `edits[${i}]: the text occurs ${count} times. Add more context to find, or set all:true.`,
        { index: i, occurrences: count },
      );
    text = parts.join(edit.replace);
  });
  return text;
}

export const updateNote = mcpTool({
  name: "update_note",
  tier: "native",
  scope: "vault",
  permission: "note.write",
  writes: true,
  input: z.object({
    path: pathArg(),
    edits: z
      .array(editSchema)
      .min(1)
      .max(100)
      .optional()
      .describe("Find/replace pairs, applied in order; all or none."),
    append: z
      .string()
      .optional()
      .describe("Text added at the end (a newline is inserted if needed)."),
    content: z.string().optional().describe("Replace the whole file. Prefer edits or append."),
  }),
  description:
    "Change an existing note with small edits. Edits merge with what others changed meanwhile. Example: {path:'Plan.md', edits:[{find:'TODO', replace:'DONE'}]} or {path:'Log.md', append:'- shipped'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    ctx.access.requireTree("note.write", ctx.vault, path);
    if (args.content !== undefined && (args.edits || args.append !== undefined))
      throw invalid("Give either content, or edits and/or append, not both.");
    if (args.content === undefined && !args.edits && args.append === undefined)
      throw invalid("Nothing to do: give edits, append or content.");
    const result = await modifyText(ctx, path, (current) => {
      let next = args.content ?? current;
      if (args.edits) next = applyEdits(next, args.edits);
      if (args.append !== undefined)
        next = next === "" || next.endsWith("\n") ? next + args.append : `${next}\n${args.append}`;
      checkContent(path, next);
      return next;
    });
    return { path, version: result.version, changed: result.changed };
  },
});

export const moveNote = mcpTool({
  name: "move_note",
  tier: "native",
  scope: "vault",
  permission: "note.write",
  writes: true,
  input: z.object({
    from: pathArg("Existing file or folder."),
    to: pathArg("New path (a rename is a move within the folder)."),
  }),
  description:
    "Move or rename a file or folder. Links in other notes are not rewritten. Example: {from:'Inbox/a.md', to:'Projects/a.md'}.",
  handler: async (args, ctx) => {
    const from = cleanPath(args.from);
    const to = cleanPath(args.to);
    readableIn(ctx).require(from);
    // Moving takes a thing out of one place and puts it in another: both must allow it.
    ctx.access.requireTree("note.delete", ctx.vault, from);
    ctx.access.requireTree("note.write", ctx.vault, to);
    const moved = await ctx.deps.vaults.move(ctx.vault, from, to, (pairs) =>
      recorder(ctx)(pairs.flat()),
    );
    return { path: moved.path };
  },
});

export const deleteNote = mcpTool({
  name: "delete_note",
  tier: "native",
  scope: "vault",
  permission: "note.delete",
  writes: true,
  destructive: true,
  input: z.object({ path: pathArg("File or folder (with everything in it).") }),
  description:
    "Delete a file or folder. It stays in the version history and can be restored from there. Example: {path:'Old/draft.md'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    ctx.access.requireTree("note.delete", ctx.vault, path);
    await ctx.deps.vaults.deleteFile(ctx.vault, path, (paths) => recorder(ctx)(paths));
    return { path, deleted: true };
  },
});

export const setNotePropertyTool = mcpTool({
  name: "set_note_property",
  tier: "native",
  scope: "vault",
  permission: "note.write",
  writes: true,
  input: z.object({
    path: pathArg("A Markdown note."),
    key: z.string().min(1).max(200).describe("Property name, e.g. `status`."),
    value: z
      .unknown()
      .describe(
        "String, number, boolean, list or date text. null (or empty) removes the property.",
      ),
  }),
  description:
    "Set or remove one frontmatter property of a note; other properties and the text stay as they are. Properties are what databases (.base) filter and show. Example: {path:'Task.md', key:'status', value:'done'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    if (fileKind(path) !== "markdown") throw invalid(`${path} is not a Markdown note.`);
    ctx.access.requireTree("note.write", ctx.vault, path);
    const result = await modifyText(ctx, path, (current) => {
      try {
        return setNoteProperty(current, args.key, args.value);
      } catch (err) {
        if (err instanceof BaseError) throw invalid(err.message);
        throw err;
      }
    });
    return { path, key: args.key, version: result.version, changed: result.changed };
  },
});
