import type {
  BaseColumn,
  BaseFile,
  BaseGroup,
  BaseResult,
  BaseView,
  CellValue,
} from "@palimvo/core";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { columnLabel } from "./labels.ts";
import { imageTarget, inputText, isEditable, isTagColumn, parseInput, titleOf } from "./model.ts";

export type Configure = (change: (base: BaseFile, view: BaseView) => void) => Promise<void>;

export interface RowsProps {
  result: BaseResult;
  indices: number[];
  /** Tables show groups as headed sections of one table, so the columns line up. */
  groups?: BaseGroup[];
  canEdit: boolean;
  configure?: Configure | undefined;
  sort?: { property: string; direction: "ASC" | "DESC" } | undefined;
  onOpen: (path: string) => void;
  onOpenLink?: ((target: string) => void) | undefined;
  onSet: (path: string, column: BaseColumn, value: CellValue) => Promise<void>;
}

export function groupLabel(label: string, property: string, none: string): string {
  return label ? (isTagColumn(property) ? `#${label}` : label) : none;
}

/** A card's cover: only web addresses until vault files can be served as images. */
function coverUrl(value: CellValue): string | null {
  const target = imageTarget(value);
  return target && /^https?:\/\//.test(target) ? target : null;
}

/** The notes of one view as a table (groups are headed sections) or as cards. */
export function BaseRows(props: RowsProps) {
  const { t } = useTranslation();
  const { result, indices, sort, configure } = props;
  const view = result.view;
  const none = t("bases.noValue");

  if (view.type === "cards") {
    const image = view.image;
    return (
      <div className="base-cards">
        {indices.map((i) => {
          const row = result.rows[i]!;
          const cover = image ? coverUrl(row.cells[image] ?? null) : null;
          return (
            <div key={row.path} className="base-card">
              {cover && <img src={cover} alt="" loading="lazy" />}
              <button
                type="button"
                className="base-card-title"
                onClick={() => props.onOpen(row.path)}
              >
                {titleOf(row.path)}
              </button>
              {result.columns
                .filter((c) => c.id !== "file.name")
                .map((c) => (
                  <div key={c.id} className="base-card-field">
                    <span className="base-card-label">{columnLabel(t, c.id)}</span>
                    <Cell {...props} path={row.path} column={c} value={row.cells[c.id] ?? null} />
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    );
  }

  const toggleSort = (id: string) =>
    void configure?.((_b, v) => {
      const current = v.sort?.[0];
      v.sort =
        current?.property !== id
          ? [{ property: id, direction: "ASC" }]
          : current.direction === "ASC"
            ? [{ property: id, direction: "DESC" }]
            : undefined;
    });

  return (
    <div className="base-table-wrap">
      <table className="base-table">
        <thead>
          <tr>
            {result.columns.map((c) => {
              const sorted = sort?.property === c.id;
              return (
                <th
                  key={c.id}
                  aria-sort={
                    sorted ? (sort.direction === "ASC" ? "ascending" : "descending") : undefined
                  }
                >
                  {configure ? (
                    <button
                      type="button"
                      className="base-sort"
                      title={t("bases.sortHint")}
                      onClick={() => toggleSort(c.id)}
                    >
                      {columnLabel(t, c.id)}
                      {sorted ? (sort.direction === "ASC" ? " ↑" : " ↓") : ""}
                    </button>
                  ) : (
                    <>
                      {columnLabel(t, c.id)}
                      {sorted ? (sort.direction === "ASC" ? " ↑" : " ↓") : ""}
                    </>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        {(props.groups ?? [{ label: "", rows: indices }]).map((g) => (
          <tbody key={g.label}>
            {props.groups && (
              <tr className="base-group-row">
                <th colSpan={result.columns.length}>
                  {groupLabel(g.label, view.groupBy!.property, none)} <span>{g.rows.length}</span>
                </th>
              </tr>
            )}
            {g.rows.map((i) => {
              const row = result.rows[i]!;
              return (
                <tr key={row.path}>
                  {result.columns.map((c) => (
                    <td key={c.id}>
                      <Cell {...props} path={row.path} column={c} value={row.cells[c.id] ?? null} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** One value: a link to the note, tag chips, a checkbox, or text that editors can click to change. */
function Cell({
  path,
  column,
  value,
  canEdit,
  onOpen,
  onOpenLink,
  onSet,
}: RowsProps & { path: string; column: BaseColumn; value: CellValue }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const editable = isEditable(column, canEdit);
  if (column.id === "file.name" || column.id === "file.basename") {
    return (
      <button type="button" className="base-link" onClick={() => onOpen(path)}>
        {titleOf(path)}
      </button>
    );
  }
  if (typeof value === "boolean" || (editable && value === null && column.key.startsWith("is"))) {
    return (
      <input
        type="checkbox"
        checked={value === true}
        disabled={!editable}
        onChange={(e) => void onSet(path, column, e.target.checked)}
        aria-label={columnLabel(t, column.id)}
      />
    );
  }
  if (editing) {
    return (
      <CellInput
        value={value}
        label={columnLabel(t, column.id)}
        onDone={(next) => {
          setEditing(false);
          if (next !== undefined) void onSet(path, column, next);
        }}
      />
    );
  }
  const shown = renderValue(value, isTagColumn(column.id), onOpenLink);
  if (!editable) return <div className="base-cell">{shown}</div>;
  return (
    <div
      className="base-cell editable"
      role="button"
      tabIndex={0}
      title={t("bases.editHint")}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setEditing(true);
        }
      }}
    >
      {shown}
    </div>
  );
}

function renderValue(
  value: CellValue,
  tags: boolean,
  onOpenLink?: (target: string) => void,
): ReactNode {
  if (value === null || value === "") return <span className="base-blank">—</span>;
  if (Array.isArray(value)) {
    return (
      <span className="base-chips">
        {value.map((v, i) => (
          <span key={i} className={`base-chip${tags ? " tag" : ""}`}>
            {tags ? `#${String(v)}` : renderValue(v, false, onOpenLink)}
          </span>
        ))}
      </span>
    );
  }
  if (typeof value === "string") {
    const link = /^\[\[([^\]]+)\]\]$/.exec(value.trim());
    if (link && onOpenLink) {
      const [target, alias] = link[1]!.split("|");
      return (
        <a
          className="base-link"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenLink(target!);
          }}
        >
          {alias ?? target}
        </a>
      );
    }
    if (/^https?:\/\/\S+$/.test(value)) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
        >
          {value}
        </a>
      );
    }
  }
  return String(value);
}

/** Text to type a value into: Enter or leaving the field saves, Escape cancels. */
function CellInput({
  value,
  label,
  onDone,
}: {
  value: CellValue;
  label: string;
  onDone: (value: CellValue | undefined) => void;
}) {
  const initial = inputText(value);
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (!commit || text === initial) return onDone(undefined);
    onDone(parseInput(text, value));
  };
  return (
    <input
      className="base-input"
      aria-label={label}
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
    />
  );
}
