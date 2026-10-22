import { z } from "zod";
import { AppError } from "@palimvo/core";
import type { ProposalSummary, ProposalView } from "../../proposals/proposals.ts";
import { cleanPath, mcpTool, readableIn, type Ctx } from "./shared.ts";

const hunk = z.object({
  before: z
    .string()
    .describe(
      "Exact text to replace; it must occur once in the file. Use '' only to fill an empty or new file.",
    ),
  after: z.string().describe("The text to put in its place ('' deletes)."),
  why: z.string().max(2000).optional().describe("Why this particular change."),
});

/** Whether a folder-limited token may read every file the proposal mentions. */
function visibleTo(ctx: Ctx, paths: readonly string[]): boolean {
  const guard = readableIn(ctx);
  return paths.every((p) => guard.can(p));
}

const pathsOf = (p: Pick<ProposalView, "files" | "sources">): string[] => [
  ...p.files.map((f) => f.path),
  ...p.sources.map((s) => s.path),
];

export const createEditProposal = mcpTool({
  name: "create_edit_proposal",
  tier: "native",
  scope: "vault",
  permission: "proposal.create",
  writes: true,
  input: z.object({
    title: z.string().min(1).max(200).describe("What the proposal does, in a few words."),
    rationale: z.string().max(10_000).optional().describe("Why; defaults to `reason`."),
    sources: z
      .array(z.object({ path: z.string(), label: z.string().max(200).optional() }))
      .max(50)
      .optional()
      .describe("Notes the proposal is based on."),
    files: z
      .array(
        z.object({
          path: z.string().min(1).describe("Note, canvas or database to change."),
          base_version: z
            .string()
            .nullable()
            .describe("The `version` read_note returned for it; null to create the file."),
          hunks: z.array(hunk).min(1).max(200),
        }),
      )
      .min(1)
      .max(100),
  }),
  description:
    "Propose changes to one or more notes without changing them; a person reviews each change and accepts or rejects it. Use this when you may not write directly, or when the change should be checked first. Example: {title:'Move launch', reason:'Vendor delay', files:[{path:'Plan.md', base_version:'3fa9…', hunks:[{before:'June', after:'September'}]}]}.",
  handler: async (args, ctx) => {
    const guard = readableIn(ctx);
    const files = args.files.map((f) => {
      const path = cleanPath(f.path);
      guard.require(path);
      return {
        path,
        baseRevision: f.base_version,
        hunks: f.hunks.map((h) => ({
          before: h.before,
          after: h.after,
          rationale: h.why ?? "",
        })),
      };
    });
    const sources = (args.sources ?? []).map((s) => {
      const path = cleanPath(s.path);
      guard.require(path);
      return { path, ...(s.label ? { label: s.label } : {}) };
    });
    const proposal = await ctx.deps.proposals.create(
      ctx.vault,
      {
        title: args.title,
        rationale: args.rationale ?? ctx.note.reason ?? "",
        sources,
        files,
      },
      ctx.author,
    );
    return {
      id: proposal.id,
      state: proposal.state,
      files: proposal.files.map((f) => ({ path: f.path, changes: f.hunks.length })),
      next: "Nothing was changed yet. A person with review rights accepts or rejects each change; the notes only change when they accept.",
    };
  },
});

const summaryOf = (p: ProposalSummary) => ({
  id: p.id,
  title: p.title,
  state: p.state,
  out_of_date: p.stale,
  proposed_by: p.proposedBy.name,
  updated: p.updatedAt,
  files: p.files.map((f) => ({
    path: f.path,
    waiting: f.pending,
    accepted: f.accepted,
    rejected: f.rejected,
  })),
});

export const listEditProposals = mcpTool({
  name: "list_edit_proposals",
  tier: "advanced",
  scope: "vault",
  permission: "proposal.create",
  input: z.object({
    all: z.boolean().optional().describe("Include proposals that are fully decided."),
  }),
  description:
    "List edit proposals in a vault: who proposed them, which files, and how many changes are waiting, accepted or rejected. Example: {} for the open ones.",
  handler: async (args, ctx) => {
    const list = await ctx.deps.proposals.list(ctx.vault, { open: !args.all });
    // A proposal quotes its files, so a folder-limited token sees it only if it may read all of them.
    return {
      proposals: list.filter((p) => visibleTo(ctx, [...p.files.map((f) => f.path)])).map(summaryOf),
    };
  },
});

export const getEditProposal = mcpTool({
  name: "get_edit_proposal",
  tier: "advanced",
  scope: "vault",
  permission: "proposal.create",
  input: z.object({ id: z.string().min(1).describe("From list_edit_proposals.") }),
  description:
    "Read one edit proposal with each change and whether it was accepted or rejected, and whether its notes changed since (then it can only be rejected and must be proposed again). Example: {id:'…'}.",
  handler: async (args, ctx) => {
    const p = await ctx.deps.proposals.get(ctx.vault, args.id);
    if (!visibleTo(ctx, pathsOf(p))) throw new AppError("not_found");
    return {
      id: p.id,
      title: p.title,
      rationale: p.rationale,
      state: p.state,
      out_of_date: p.stale,
      proposed_by: p.proposedBy.name,
      files: p.files.map((f) => ({
        path: f.path,
        status: f.status,
        changes: f.hunks.map((h) => ({
          id: h.id,
          state: h.state,
          before: h.before,
          after: h.after,
          why: h.rationale,
          ...(h.reviewedBy ? { decided_by: h.reviewedBy.name } : {}),
        })),
      })),
    };
  },
});
