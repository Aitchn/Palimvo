import type { ActivityFilter, Author } from "@palimvo/core";
import { isHiddenPath } from "../auth/publicPolicy.ts";
import type { CommitInfo } from "../history/history.ts";

/** How many of the latest commits the activity wall looks at. */
export const ACTIVITY_WINDOW = 200;
export const MAX_ACTIVITY_ENTRIES = 100;

export interface ActivityAuthor {
  author: Author;
  /** Changes by this author within the window. */
  count: number;
  /** When they last changed something. */
  lastAt: string;
}

export interface Activity {
  filter: ActivityFilter;
  /** The newest changes that match the filter, newest first. */
  entries: CommitInfo[];
  /** Everyone active in the window (ignoring the filter), most recently active first. */
  authors: ActivityAuthor[];
}

const matches = (filter: ActivityFilter, author: Author): boolean =>
  filter === "all" ||
  (filter === "human" ? author.kind === "human" : author.kind === "ai" || author.kind === "plugin");

/**
 * Turns the vault's latest commits into the activity wall. Changes that only touched the app's
 * own files (`.palimvo/…`) are left out; a commit with no files at all (a checkpoint) stays.
 */
export function summarizeActivity(
  commits: readonly CommitInfo[],
  filter: ActivityFilter,
  limit: number,
): Activity {
  const visible = commits
    .filter((c) => c.files.length === 0 || c.files.some((f) => !isHiddenPath(f)))
    .map((c) => ({ ...c, files: c.files.filter((f) => !isHiddenPath(f)) }));
  const byAuthor = new Map<string, ActivityAuthor>();
  for (const commit of visible) {
    const key = `${commit.author.kind}:${commit.author.id}`;
    const seen = byAuthor.get(key);
    if (seen) seen.count++;
    else byAuthor.set(key, { author: commit.author, count: 1, lastAt: commit.date });
  }
  return {
    filter,
    entries: visible
      .filter((c) => matches(filter, c.author))
      .slice(0, Math.min(Math.max(limit, 1), MAX_ACTIVITY_ENTRIES)),
    authors: [...byAuthor.values()].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)),
  };
}
