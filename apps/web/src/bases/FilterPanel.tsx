import type { BaseFile, BaseFilter, BaseResult, BaseView } from "@palimvo/core";
import type { TFunction } from "i18next";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Icon } from "../ui/index.ts";

type Scope = "all" | "view";

interface Props {
  base: BaseFile | undefined;
  view: BaseView;
  available: BaseResult["available"];
  onChange: (scope: Scope, filters: BaseFilter | undefined) => void;
}

/** A list of conditions that all (or any) must hold; anything more nested is edited as YAML. */
interface SimpleFilter {
  mode: "and" | "or";
  items: string[];
}

export function simpleFilter(f: BaseFilter | undefined): SimpleFilter | null {
  if (f === undefined) return { mode: "and", items: [] };
  if (typeof f === "string") return { mode: "and", items: f.trim() ? [f] : [] };
  if ("and" in f && f.and.every((x) => typeof x === "string"))
    return { mode: "and", items: f.and as string[] };
  if ("or" in f && f.or.every((x) => typeof x === "string"))
    return { mode: "or", items: f.or as string[] };
  return null;
}

export function toFilter(s: SimpleFilter): BaseFilter | undefined {
  if (s.items.length === 0) return undefined;
  return s.mode === "and" ? { and: s.items } : { or: s.items };
}

const quote = (v: string) => JSON.stringify(v);

/** Reads a condition back as words, for the common shapes; anything else is shown as written. */
export function describeCondition(expr: string, t: TFunction): string {
  const s = expr.trim();
  let m = /^(!?)file\.hasTag\(((?:\s*"[^"]*"\s*,?)+)\)$/.exec(s);
  if (m) {
    const tags = [...m[2]!.matchAll(/"([^"]*)"/g)]
      .map((x) => `#${x[1]}`)
      .join(t("bases.filters.or"));
    return t(m[1] ? "bases.filters.descNoTag" : "bases.filters.descHasTag", { tags });
  }
  m = /^(!?)file\.inFolder\("([^"]*)"\)$/.exec(s);
  if (m)
    return t(m[1] ? "bases.filters.descNotInFolder" : "bases.filters.descInFolder", {
      folder: m[2],
    });
  m = /^(!?)file\.hasLink\("([^"]*)"\)$/.exec(s);
  if (m) return t(m[1] ? "bases.filters.descNoLink" : "bases.filters.descLink", { target: m[2] });
  return s;
}

type Kind = "tag" | "folder" | "property" | "expr";
const OPERATORS = ["==", "!=", "contains", ">", "<", "filled", "empty"] as const;
type Operator = (typeof OPERATORS)[number];
const OPERATOR_KEYS: Record<Operator, string> = {
  "==": "opEq",
  "!=": "opNe",
  contains: "opContains",
  ">": "opGt",
  "<": "opLt",
  filled: "opFilled",
  empty: "opEmpty",
};

function propertyRef(name: string): string {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : `note[${quote(name)}]`;
}

function literal(v: string): string {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) || t === "true" || t === "false") return t;
  return quote(t);
}

/** The expression for what the condition builder holds, or null while it is incomplete. */
export function buildCondition(input: {
  kind: Kind;
  negate: boolean;
  value: string;
  property: string;
  op: Operator;
}): string | null {
  const v = input.value.trim();
  switch (input.kind) {
    case "tag":
      return v ? `${input.negate ? "!" : ""}file.hasTag(${quote(v.replace(/^#/, ""))})` : null;
    case "folder":
      return v ? `${input.negate ? "!" : ""}file.inFolder(${quote(v)})` : null;
    case "expr":
      return v || null;
    case "property": {
      const p = input.property.trim();
      if (!p) return null;
      const ref = propertyRef(p);
      if (input.op === "filled") return `!${ref}.isEmpty()`;
      if (input.op === "empty") return `${ref}.isEmpty()`;
      if (!v) return null;
      if (input.op === "contains") return `${ref}.contains(${quote(v)})`;
      return `${ref} ${input.op} ${literal(v)}`;
    }
  }
}

function ConditionBuilder({
  available,
  onAdd,
}: {
  available: BaseResult["available"];
  onAdd: (expr: string) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const [kind, setKind] = useState<Kind>("tag");
  const [negate, setNegate] = useState(false);
  const [value, setValue] = useState("");
  const [property, setProperty] = useState("");
  const [op, setOp] = useState<Operator>("==");
  const expr = buildCondition({ kind, negate, value, property, op });

  return (
    <form
      className="base-panel-row base-condition"
      onSubmit={(e) => {
        e.preventDefault();
        if (!expr) return;
        onAdd(expr);
        setValue("");
      }}
    >
      <select
        className="select"
        value={kind}
        onChange={(e) => setKind(e.target.value as Kind)}
        aria-label={t("bases.filters.kind")}
      >
        <option value="tag">{t("bases.filters.kindTag")}</option>
        <option value="folder">{t("bases.filters.kindFolder")}</option>
        <option value="property">{t("bases.filters.kindProperty")}</option>
        <option value="expr">{t("bases.filters.kindExpr")}</option>
      </select>
      {(kind === "tag" || kind === "folder") && (
        <>
          <select
            className="select"
            value={negate ? "not" : "is"}
            onChange={(e) => setNegate(e.target.value === "not")}
            aria-label={t("bases.filters.polarity")}
          >
            <option value="is">
              {t(kind === "tag" ? "bases.filters.tagHas" : "bases.filters.folderIn")}
            </option>
            <option value="not">
              {t(kind === "tag" ? "bases.filters.tagNot" : "bases.filters.folderNot")}
            </option>
          </select>
          <input
            className="input"
            list={`${ids}-${kind}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t(
              kind === "tag" ? "bases.filters.tagPlaceholder" : "bases.filters.folderPlaceholder",
            )}
            aria-label={t(kind === "tag" ? "bases.filters.kindTag" : "bases.filters.kindFolder")}
          />
        </>
      )}
      {kind === "property" && (
        <>
          <input
            className="input"
            list={`${ids}-property`}
            value={property}
            onChange={(e) => setProperty(e.target.value)}
            placeholder={t("bases.filters.propertyPlaceholder")}
            aria-label={t("bases.filters.kindProperty")}
          />
          <select
            className="select"
            value={op}
            onChange={(e) => setOp(e.target.value as Operator)}
            aria-label={t("bases.filters.operator")}
          >
            {OPERATORS.map((o) => (
              <option key={o} value={o}>
                {t(`bases.filters.${OPERATOR_KEYS[o]}`)}
              </option>
            ))}
          </select>
          {op !== "filled" && op !== "empty" && (
            <input
              className="input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t("bases.filters.valuePlaceholder")}
              aria-label={t("bases.filters.valuePlaceholder")}
            />
          )}
        </>
      )}
      {kind === "expr" && (
        <input
          className="input wide"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("bases.filters.exprPlaceholder")}
          aria-label={t("bases.filters.kindExpr")}
        />
      )}
      <Button type="submit" disabled={!expr}>
        {t("bases.filters.add")}
      </Button>
      <datalist id={`${ids}-tag`}>
        {available.tags.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
      <datalist id={`${ids}-folder`}>
        {available.folders.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <datalist id={`${ids}-property`}>
        {available.properties.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </form>
  );
}

function FilterGroup({
  title,
  filter,
  available,
  onChange,
}: {
  title: string;
  filter: BaseFilter | undefined;
  available: BaseResult["available"];
  onChange: (f: BaseFilter | undefined) => void;
}) {
  const { t } = useTranslation();
  const s = simpleFilter(filter);
  if (!s) {
    return (
      <div className="base-filter-group">
        <div className="base-panel-title">{title}</div>
        <div className="base-hint">{t("bases.filters.nested")}</div>
      </div>
    );
  }
  return (
    <div className="base-filter-group">
      <div className="base-panel-title">
        {title}
        {s.items.length > 1 && (
          <select
            className="select"
            value={s.mode}
            onChange={(e) =>
              onChange(toFilter({ ...s, mode: e.target.value as SimpleFilter["mode"] }))
            }
            aria-label={t("bases.filters.matchMode")}
          >
            <option value="and">{t("bases.filters.matchAll")}</option>
            <option value="or">{t("bases.filters.matchAny")}</option>
          </select>
        )}
      </div>
      {s.items.length === 0 && <div className="base-hint">{t("bases.filters.none")}</div>}
      <ul className="base-conditions">
        {s.items.map((item, i) => (
          <li key={`${i}-${item}`} title={item}>
            <span>{describeCondition(item, t)}</span>
            <Button
              variant="ghost"
              aria-label={t("bases.filters.remove")}
              onClick={() => onChange(toFilter({ ...s, items: s.items.filter((_, j) => j !== i) }))}
            >
              <Icon name="close" />
            </Button>
          </li>
        ))}
      </ul>
      <ConditionBuilder
        available={available}
        onAdd={(expr) => onChange(toFilter({ ...s, items: [...s.items, expr] }))}
      />
    </div>
  );
}

/** Which notes are rows: conditions for every view of the database, and for the view being shown. */
export function FilterPanel({ base, view, available, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className="base-panel base-filters">
      <FilterGroup
        title={t("bases.filters.shared")}
        filter={base?.filters}
        available={available}
        onChange={(f) => onChange("all", f)}
      />
      <FilterGroup
        title={t("bases.filters.onlyView", { view: view.name })}
        filter={view.filters}
        available={available}
        onChange={(f) => onChange("view", f)}
      />
    </div>
  );
}
