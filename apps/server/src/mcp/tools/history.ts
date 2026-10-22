import { z } from "zod";
import { cleanPath, invalid, readableIn, mcpTool } from "./shared.ts";

const MAX_DIFF_CHARS = 60_000;

export const getHistory = mcpTool({
  name: "get_history",
  tier: "native",
  scope: "vault",
  permission: "history.view",
  input: z.object({
    path: z.string().optional().describe("Only changes to this file; default the whole vault."),
    limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
  }),
  description:
    "Recent changes, newest first: who made each (people and AI clients), why, and which files. Use the id with get_diff. Example: {path:'Plan.md', limit:5}.",
  handler: async (args, ctx) => {
    const { history } = ctx.deps;
    const guard = readableIn(ctx);
    const path = args.path ? cleanPath(args.path) : undefined;
    if (path) guard.require(path);
    // Changes still waiting for their timer are committed so the list is current.
    await history.commit(ctx.vault).catch(() => undefined);
    const commits = await history.list(ctx.vault, {
      ...(path ? { path } : {}),
      limit: args.limit ?? 20,
    });
    const shown = commits
      .map((c) => ({ ...c, files: c.files.filter((f) => guard.can(f)) }))
      .filter((c) => !guard.limited || c.files.length > 0);
    return {
      commits: shown.map((c) => ({
        id: c.id.slice(0, 12),
        date: c.date,
        author: { name: c.author.name, kind: c.author.kind },
        ...(c.coAuthors.length > 0 ? { co_authors: c.coAuthors.map((a) => a.name) } : {}),
        subject: c.subject,
        ...(c.reasons.length > 0 ? { reasons: c.reasons } : {}),
        ...(c.checkpoint ? { checkpoint: true } : {}),
        files: c.files,
      })),
    };
  },
});

export const getDiff = mcpTool({
  name: "get_diff",
  tier: "native",
  scope: "vault",
  permission: "history.view",
  input: z.object({
    commit: z.string().min(4).max(64).describe("An id from get_history."),
    path: z.string().optional().describe("Only this file's part of the change."),
  }),
  description:
    "What one change did, as a unified diff. Example: {commit:'3fa9c1d2e4b5', path:'Plan.md'}.",
  handler: async (args, ctx) => {
    const guard = readableIn(ctx);
    const path = args.path ? cleanPath(args.path) : undefined;
    // A diff of the whole change would show files a folder-limited token may not read.
    if (guard.limited && !path) throw invalid("This token is limited to folders: pass `path`.");
    if (path) guard.require(path);
    const diff = await ctx.deps.history.diff(ctx.vault, args.commit, path);
    const truncated = diff.length > MAX_DIFF_CHARS;
    return {
      commit: args.commit,
      diff: truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff,
      ...(truncated ? { truncated: true, length: diff.length } : {}),
    };
  },
});
