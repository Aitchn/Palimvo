import { stripCode } from "./links.ts";

/**
 * Obsidian tag syntax: `#` followed by letters, digits, `_`, `-` or `/` with at least one
 * non-digit, and not glued to a preceding word character (so `a#b` and `#123` are not tags).
 */
const INLINE_TAG = /(?<![\p{L}\p{N}_&/#])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** Lower-cases nothing: tags keep their case, but lose a leading `#` and surrounding space. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, "");
}

/** Inline `#tags` of a markdown body, without `#`, in order of first use, ignoring code. */
export function extractInlineTags(markdown: string): string[] {
  const found = new Set<string>();
  for (const line of stripCode(markdown).split("\n")) {
    // A line that starts with "# " is a heading, which the pattern already excludes (the space).
    for (const match of line.matchAll(INLINE_TAG)) found.add(match[1]!);
  }
  return [...found];
}

/** Whether `tag` is `parent` or one of its nested tags (`project/a` is inside `project`). */
export function tagIsInside(tag: string, parent: string): boolean {
  const t = tag.toLowerCase();
  const p = parent.toLowerCase();
  return t === p || t.startsWith(`${p}/`);
}
