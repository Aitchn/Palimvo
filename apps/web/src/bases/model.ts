import {
  FILE_COLUMNS,
  parseBase,
  type BaseColumn,
  type BaseFile,
  type BaseFilter,
  type BaseResult,
  type CellValue,
} from "@palimvo/core";

/** The settings of a database, or undefined while its YAML cannot be read. */
export function parseQuiet(source: string | null): BaseFile | undefined {
  try {
    return source === null ? undefined : parseBase(source);
  } catch {
    return undefined;
  }
}

export function countFilters(f: BaseFilter | undefined): number {
  if (f === undefined) return 0;
  if (typeof f === "string") return f.trim() ? 1 : 0;
  return Object.values(f)[0]!.length;
}

export const isTagColumn = (id: string): boolean =>
  id === "file.tags" || id === "tags" || id === "note.tags";

export const titleOf = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** Columns a view can show: file fields, every property the notes have, and the formulas. */
export function columnChoices(result: BaseResult): string[] {
  const ids = [
    ...FILE_COLUMNS,
    ...result.available.properties,
    ...result.available.formulas.map((f) => `formula.${f}`),
  ];
  return [...new Set(ids)];
}

/** Text typed into a cell: lists as "a, b"; numbers stay numbers; empty removes the property. */
export function parseInput(text: string, previous: CellValue): CellValue {
  const t = text.trim();
  if (t === "") return null;
  if (Array.isArray(previous))
    return t
      .split(",")
      .map((s) => s.trim().replace(/^#/, ""))
      .filter(Boolean);
  if ((typeof previous === "number" || previous === null) && /^-?\d+(\.\d+)?$/.test(t))
    return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return t;
}

/** A cell as editable text. */
export function inputText(value: CellValue): string {
  return Array.isArray(value) ? value.join(", ") : value === null ? "" : String(value);
}

/** The first image a cell names: a URL, or a file in the vault (`[[cover.png]]`). */
export function imageTarget(value: CellValue): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !text.trim()) return null;
  return (
    text
      .trim()
      .replace(/^!?\[\[|\]\]$/g, "")
      .split("|")[0] ?? null
  );
}

/** Only note properties can be edited in place. */
export const isEditable = (column: BaseColumn, canEdit: boolean): boolean =>
  canEdit && column.source === "note";

/** A fresh `.base` file: the notes of a folder or tag (or all notes), with the chosen columns. */
export function newBaseSource(options: {
  folder?: string;
  tag?: string;
  columns: string[];
  viewName: string;
  type: "table" | "cards";
}): string {
  const quote = (v: string) => JSON.stringify(v);
  const conditions: string[] = [];
  if (options.folder) conditions.push(`file.inFolder(${quote(options.folder)})`);
  if (options.tag) conditions.push(`file.hasTag(${quote(options.tag.replace(/^#/, ""))})`);
  const lines: string[] = [];
  if (conditions.length > 0) {
    lines.push("filters:", "  and:");
    for (const c of conditions) lines.push(`    - ${quote(c)}`);
  }
  lines.push("views:", `  - type: ${options.type}`, `    name: ${quote(options.viewName)}`);
  lines.push("    order:");
  for (const c of options.columns) lines.push(`      - ${quote(c)}`);
  return `${lines.join("\n")}\n`;
}
