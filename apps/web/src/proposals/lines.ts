export interface DisplayLine {
  kind: "context" | "del" | "add";
  text: string;
}

interface HunkText {
  before: string;
  after: string;
  contextBefore: string;
  contextAfter: string;
}

/** Splits text into lines; a trailing newline ends the last line instead of starting an empty one. */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const CONTEXT_LINES = 2;

/**
 * A change shown like a unified diff: the whole lines it touches (the text around it in those
 * lines comes from the context kept with it), what they were, what they become, and a line or two
 * of untouched text on each side.
 */
export function hunkDisplay(h: HunkText): DisplayLine[] {
  const cut = h.contextBefore.lastIndexOf("\n");
  // The newline at `cut` ends the last line above, so those lines are split as they are.
  const above = cut < 0 ? [] : h.contextBefore.slice(0, cut).split("\n");
  const head = h.contextBefore.slice(cut + 1);
  const next = h.contextAfter.indexOf("\n");
  const tail = next < 0 ? h.contextAfter : h.contextAfter.slice(0, next);
  const below = next < 0 ? [] : toLines(h.contextAfter.slice(next + 1));

  const oldLines = toLines(head + h.before + tail);
  const newLines = toLines(head + h.after + tail);
  // Lines that are the same on both sides are context, not part of the change.
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let end = 0;
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines.at(-1 - end) === newLines.at(-1 - end)
  ) {
    end++;
  }
  const lead = [...above, ...oldLines.slice(0, start)].slice(-CONTEXT_LINES);
  const trail = [...oldLines.slice(oldLines.length - end), ...below].slice(0, CONTEXT_LINES);
  return [
    ...lead.map((text): DisplayLine => ({ kind: "context", text })),
    ...oldLines
      .slice(start, oldLines.length - end)
      .map((text): DisplayLine => ({ kind: "del", text })),
    ...newLines
      .slice(start, newLines.length - end)
      .map((text): DisplayLine => ({ kind: "add", text })),
    ...trail.map((text): DisplayLine => ({ kind: "context", text })),
  ];
}
