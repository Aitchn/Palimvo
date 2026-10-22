/**
 * Folder patterns used by a plugin's `permissions.read` and `permissions.write`.
 *
 * - A pattern without wildcards is a folder (or a single file): it covers that path and
 *   everything inside it, so `decisions` covers `decisions/0001-a.md` but not `decisions-old/x.md`.
 * - `*` matches any characters inside one path segment; `**` as a whole segment matches any
 *   number of segments (including none). With wildcards the pattern is matched exactly, so
 *   `notes/*` covers `notes/a.md` but not `notes/sub/b.md`.
 * - Matching is case sensitive and runs on vault-relative paths with `/` separators.
 */

export const MAX_GLOB_LENGTH = 200;

/** Why a pattern is refused, or undefined when it is fine. */
export function globProblem(pattern: string): string | undefined {
  if (pattern.length === 0) return 'is empty (use "**" for the whole vault)';
  if (pattern.length > MAX_GLOB_LENGTH) return `is longer than ${MAX_GLOB_LENGTH} characters`;
  if (pattern.startsWith("/")) return "must be relative to the vault root";
  if (pattern.endsWith("/")) return 'must not end with "/"';
  if (/[\\\0?[\]{}!]/.test(pattern)) return "must not contain \\ ? [ ] { } ! or NUL";
  for (const segment of pattern.split("/")) {
    if (segment === "") return 'must not contain an empty segment ("//")';
    if (segment === "." || segment === "..") return 'must not contain "." or ".." segments';
    if (segment.includes("**") && segment !== "**") return '"**" must be a whole segment';
  }
  return undefined;
}

function matchSegments(pattern: string[], path: string[], p = 0, s = 0): boolean {
  if (p === pattern.length) return s === path.length;
  const segment = pattern[p] as string;
  if (segment === "**") {
    for (let skip = s; skip <= path.length; skip++) {
      if (matchSegments(pattern, path, p + 1, skip)) return true;
    }
    return false;
  }
  const name = path[s];
  if (name === undefined) return false;
  const ok =
    segment === name ||
    (segment.includes("*") &&
      new RegExp(`^${segment.split("*").map(escapeRegExp).join("[^/]*")}$`).test(name));
  return ok && matchSegments(pattern, path, p + 1, s + 1);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `path` (vault-relative) is covered by one pattern. Invalid patterns and paths match nothing. */
export function matchesGlob(pattern: string, path: string): boolean {
  if (globProblem(pattern) || path === "" || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  if (!pattern.includes("*")) return path === pattern || path.startsWith(`${pattern}/`);
  return matchSegments(pattern.split("/"), segments);
}

/** Whether any pattern covers `path`. */
export function pathAllowed(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path));
}
