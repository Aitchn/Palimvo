export type DiffLineKind = "hunk" | "add" | "del" | "context" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * Splits a unified diff into displayable lines. The `diff --git`, `index` and `---`/`+++` headers
 * are dropped (the dialog names the file itself); a file's first hunk is preceded by a `note` line
 * for renames and mode changes that carry no hunk of their own.
 */
export function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith("@@")) {
        inHunk = true;
        lines.push({ kind: "hunk", text: raw });
      } else if (/^(rename|copy) (from|to) |^(new|deleted) file mode |^Binary files /.test(raw)) {
        lines.push({ kind: "note", text: raw });
      }
      continue;
    }
    if (raw.startsWith("@@")) lines.push({ kind: "hunk", text: raw });
    else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1) });
    else if (raw.startsWith(" ")) lines.push({ kind: "context", text: raw.slice(1) });
    else if (raw.startsWith("\\")) lines.push({ kind: "note", text: raw });
    else if (raw === "") continue;
  }
  return lines;
}
