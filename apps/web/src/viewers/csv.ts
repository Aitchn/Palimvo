const DELIMITERS = [",", ";", "\t", "|"] as const;

/** The delimiter that splits the first line into the most cells (outside quotes). */
export function detectDelimiter(text: string): string {
  const line = text.slice(0, 4096).split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export interface ParsedCsv {
  rows: string[][];
  /** True when parsing stopped at `maxRows`. */
  truncated: boolean;
  delimiter: string;
}

/**
 * Splits CSV text into rows of cells: quoted cells may hold delimiters, line breaks and doubled
 * quotes. A leading byte order mark is dropped. Reads at most `maxRows` rows.
 */
export function parseCsv(text: string, maxRows = Infinity, delimiter?: string): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = "";
    // A blank line is not a row of one empty cell.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === d) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= maxRows) {
        return { rows, truncated: i < src.length - 1, delimiter: d };
      }
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return { rows, truncated: false, delimiter: d };
}
