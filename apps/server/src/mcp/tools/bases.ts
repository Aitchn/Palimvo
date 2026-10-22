import { z } from "zod";
import {
  BaseError,
  baseFile,
  fileKind,
  linkResolver,
  parseBase,
  queryBase,
  type FileValue,
} from "@palimvo/core";
import { eachFile, vaultFileSource } from "../../search/files.ts";
import { cleanPath, invalid, pathArg, readableIn, mcpTool } from "./shared.ts";

export const queryBaseTool = mcpTool({
  name: "query_base",
  tier: "native",
  scope: "vault",
  permission: "note.read",
  input: z.object({
    path: pathArg("A .base file."),
    view: z
      .union([z.string(), z.number().int().min(0)])
      .optional()
      .describe("View name or index; default the first."),
    limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
  }),
  description:
    "Run a database (.base): its rows are the notes that match its filters, its columns their properties. Change a row with set_note_property. Example: {path:'Tasks.base', view:'Open'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    const guard = readableIn(ctx);
    guard.require(path);
    if (fileKind(path) !== "base") throw invalid(`${path} is not a .base file.`);
    const { vaults } = ctx.deps;
    let base;
    try {
      base = parseBase((await vaults.readFile(ctx.vault, path)).content);
    } catch (err) {
      if (err instanceof BaseError) throw invalid(`${path}: ${err.message}`);
      throw err;
    }
    const paths = await vaults.listFiles(ctx.vault);
    const resolver = linkResolver(paths);
    const files: FileValue[] = [];
    await eachFile(
      vaultFileSource(vaults),
      ctx.vault,
      paths.filter((p) => fileKind(p) === "markdown" && guard.can(p)),
      (p, file) => {
        if (file)
          files.push(baseFile({ path: p, content: file.content, mtime: file.mtime }, resolver));
      },
    );
    const result = queryBase(base, files, args.view === undefined ? {} : { view: args.view });
    const limit = args.limit ?? 50;
    return {
      path,
      view: result.view.name,
      views: result.views.map((v) => v.name),
      columns: result.columns.map((c) => ({ id: c.id, label: c.label })),
      total: result.total,
      rows: result.rows.slice(0, limit),
      ...(result.groups
        ? { groups: result.groups.map((g) => ({ label: g.label, rows: g.rows.length })) }
        : {}),
      ...(result.errors.length > 0 ? { errors: result.errors } : {}),
      ...(result.rows.length > limit ? { truncated: true } : {}),
    };
  },
});
