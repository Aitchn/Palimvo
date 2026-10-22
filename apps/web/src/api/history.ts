import type { Author } from "@palimvo/core";
import { request, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;

/** One entry of a vault's version history. */
export interface CommitInfo {
  id: string;
  date: string;
  author: Author;
  coAuthors: Author[];
  subject: string;
  body: string;
  /** Why each part of the change was made, in the author's words. */
  reasons: string[];
  /** True for a commit made by "save a checkpoint". */
  checkpoint: boolean;
  tags: string[];
  files: string[];
  /** When the log is for one file: its path in this commit (it may have been renamed since). */
  path?: string;
}

export interface Checkpoint {
  name: string;
  commit: string;
  date: string;
  message: string;
}

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}`;

/** The changes to one file (following renames), or to the whole vault, newest first. */
export async function listHistory(
  vault: string,
  options: Signal & { path?: string; limit?: number } = {},
): Promise<CommitInfo[]> {
  const query = new URLSearchParams();
  if (options.path) query.set("path", options.path);
  if (options.limit) query.set("limit", String(options.limit));
  const suffix = query.size > 0 ? `?${query}` : "";
  return (
    await request<{ commits: CommitInfo[] }>(`${base(vault)}/history${suffix}`, {
      signal: options.signal,
    })
  ).commits;
}

/** What `commit` changed, as a unified diff, optionally limited to one file. */
export async function getDiff(
  vault: string,
  commit: string,
  options: Signal & { path?: string } = {},
): Promise<string> {
  const query = options.path ? `?path=${encodeURIComponent(options.path)}` : "";
  return (
    await request<{ diff: string }>(`${base(vault)}/history/${commit}/diff${query}`, {
      signal: options.signal,
    })
  ).diff;
}

/** The unified diff from one version to another. */
export async function compareVersions(
  vault: string,
  from: string,
  to: string,
  options: Signal & { path?: string } = {},
): Promise<string> {
  const query = new URLSearchParams({ from, to });
  if (options.path) query.set("path", options.path);
  return (
    await request<{ diff: string }>(`${base(vault)}/history/compare?${query}`, {
      signal: options.signal,
    })
  ).diff;
}

/** Puts a file back as it was in `commit`. `from` is its path then, when it has been renamed since. */
export function restoreVersion(
  vault: string,
  path: string,
  commit: string,
  from?: string,
): Promise<{ path: string }> {
  return request(`${base(vault)}/restore`, {
    method: "POST",
    body: { path, commit, ...(from && from !== path ? { from } : {}) },
  });
}

export async function listCheckpoints(vault: string, options: Signal = {}): Promise<Checkpoint[]> {
  return (await request<{ checkpoints: Checkpoint[] }>(`${base(vault)}/checkpoints`, options))
    .checkpoints;
}

export function createCheckpoint(
  vault: string,
  message: string,
  tag?: string,
): Promise<CommitInfo> {
  return request(`${base(vault)}/checkpoints`, {
    method: "POST",
    body: { message, ...(tag ? { tag } : {}) },
  });
}
