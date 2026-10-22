import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseCsv } from "./csv.ts";

/** Rows drawn; a table of hundreds of thousands of rows would freeze the page. */
export const MAX_CSV_ROWS = 2000;

/** A CSV file as a table whose first row is the header. */
export function CsvTable({ text }: { text: string }) {
  const { t } = useTranslation();
  const { rows, truncated } = useMemo(() => parseCsv(text, MAX_CSV_ROWS + 1), [text]);
  if (rows.length === 0) return <p className="muted">{t("workspace.emptyFile")}</p>;
  const [head = [], ...body] = rows;
  const shown = truncated ? body.slice(0, MAX_CSV_ROWS) : body;
  const columns = Math.max(head.length, ...shown.map((r) => r.length));
  const pad = (row: string[]) => Array.from({ length: columns }, (_, i) => row[i] ?? "");
  return (
    <div className="csv-view">
      <div className="csv-scroll" tabIndex={0}>
        <table className="csv-table">
          <thead>
            <tr>
              {pad(head).map((cell, i) => (
                <th key={i} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r}>
                {pad(row).map((cell, i) => (
                  <td key={i}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="muted csv-note">{t("viewers.rowsLimited", { count: MAX_CSV_ROWS })}</p>
      )}
    </div>
  );
}
