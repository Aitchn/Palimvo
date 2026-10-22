import type { Author } from "@palimvo/core";
import { request, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;

export type HunkState = "pending" | "accepted" | "rejected";
export type ProposalState = "pending" | "partial" | "accepted" | "rejected" | "resolved";
/** Whether a file still matches the version a proposal was written against. */
export type FileStatus = "current" | "stale" | "missing";

export interface ProposalHunk {
  id: string;
  before: string;
  after: string;
  rationale: string;
  /** Some of the text just before and after, as it was when the change was proposed. */
  contextBefore: string;
  contextAfter: string;
  state: HunkState;
  reviewedBy?: Author;
  reviewedAt?: string;
}

export interface ProposalFile {
  path: string;
  status: FileStatus;
  hunks: ProposalHunk[];
}

export interface Proposal {
  id: string;
  /** Sent back with a decision, so a proposal that changed meanwhile is shown again first. */
  version: number;
  title: string;
  rationale: string;
  sources: { path: string; label?: string }[];
  proposedBy: Author;
  createdAt: string;
  updatedAt: string;
  state: ProposalState;
  stale: boolean;
  files: ProposalFile[];
}

export interface ProposalSummary {
  id: string;
  version: number;
  title: string;
  rationale: string;
  state: ProposalState;
  stale: boolean;
  proposedBy: Author;
  createdAt: string;
  updatedAt: string;
  files: {
    path: string;
    status: FileStatus;
    pending: number;
    accepted: number;
    rejected: number;
  }[];
}

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}/proposals`;

/** Proposals that still have something to decide, or all of them. Newest first. */
export async function listProposals(
  vault: string,
  options: Signal & { all?: boolean } = {},
): Promise<ProposalSummary[]> {
  const suffix = options.all ? "?state=all" : "";
  return (
    await request<{ proposals: ProposalSummary[] }>(`${base(vault)}${suffix}`, {
      signal: options.signal,
    })
  ).proposals;
}

export function getProposal(vault: string, id: string, options: Signal = {}): Promise<Proposal> {
  return request<Proposal>(`${base(vault)}/${encodeURIComponent(id)}`, options);
}

/** Accepts (writes into the notes) or rejects the named hunks, or every hunk still waiting. */
export function decideProposal(
  vault: string,
  proposal: Pick<Proposal, "id" | "version">,
  action: "accept" | "reject",
  hunkIds?: readonly string[],
): Promise<Proposal> {
  return request<Proposal>(`${base(vault)}/${encodeURIComponent(proposal.id)}/${action}`, {
    method: "POST",
    body: { version: proposal.version, ...(hunkIds ? { hunkIds } : {}) },
  });
}
