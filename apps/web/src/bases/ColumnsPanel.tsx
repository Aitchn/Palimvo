import type { BaseResult } from "@palimvo/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Icon } from "../ui/index.ts";
import type { Configure } from "./BaseRows.tsx";
import { columnLabel } from "./labels.ts";
import { columnChoices, parseQuiet } from "./model.ts";
import { PromptDialog } from "./PromptDialog.tsx";

interface Props {
  result: BaseResult;
  source: string | null;
  configure: Configure;
}

type Asking = "property" | "formula" | null;

/** Which columns a view shows and in what order, plus formulas, card covers and the row limit. */
export function ColumnsPanel({ result, source, configure }: Props) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState<Asking>(null);
  const shown = result.columns.map((c) => c.id);
  const choices = useMemo(() => columnChoices(result), [result]);
  const hidden = choices.filter((id) => !shown.includes(id));
  const base = parseQuiet(source);
  const setOrder = (order: string[]) => void configure((_b, v) => (v.order = order));

  return (
    <div className="base-panel">
      <div className="base-panel-title">{t("bases.columns.shown")}</div>
      <ul className="base-columns">
        {shown.map((id, i) => (
          <li key={id}>
            <span>{columnLabel(t, id, base)}</span>
            <code>{id}</code>
            <Button
              variant="ghost"
              disabled={i === 0}
              aria-label={t("bases.columns.moveUp", { name: columnLabel(t, id, base) })}
              onClick={() =>
                setOrder(shown.map((x, j) => (j === i - 1 ? id : j === i ? shown[i - 1]! : x)))
              }
            >
              <Icon name="caret" style={{ transform: "rotate(180deg)" }} />
            </Button>
            <Button
              variant="ghost"
              aria-label={t("bases.columns.hide", { name: columnLabel(t, id, base) })}
              onClick={() => setOrder(shown.filter((x) => x !== id))}
            >
              <Icon name="close" />
            </Button>
          </li>
        ))}
      </ul>
      {hidden.length > 0 && (
        <div className="base-panel-row">
          <select
            className="select"
            value=""
            onChange={(e) => e.target.value && setOrder([...shown, e.target.value])}
            aria-label={t("bases.columns.add")}
          >
            <option value="">{t("bases.columns.addPlaceholder")}</option>
            {hidden.map((id) => (
              <option key={id} value={id}>
                {columnLabel(t, id, base)} ({id})
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="base-panel-row">
        <Button icon="add" onClick={() => setAsking("property")}>
          {t("bases.columns.newProperty")}
        </Button>
        <Button icon="add" onClick={() => setAsking("formula")}>
          {t("bases.columns.newFormula")}
        </Button>
        {result.view.type === "cards" && (
          <select
            className="select"
            value={result.view.image ?? ""}
            onChange={(e) => void configure((_b, v) => (v.image = e.target.value || undefined))}
            aria-label={t("bases.columns.cover")}
          >
            <option value="">{t("bases.columns.noCover")}</option>
            {result.available.properties.map((p) => (
              <option key={p} value={p}>
                {t("bases.columns.coverFrom", { property: p })}
              </option>
            ))}
          </select>
        )}
        <label className="base-limit">
          {t("bases.columns.limit")}
          <input
            className="input"
            type="number"
            min={0}
            defaultValue={result.view.limit ?? ""}
            placeholder={t("bases.columns.limitAll")}
            onBlur={(e) => {
              const n = Number(e.target.value);
              void configure((_b, v) => (v.limit = n > 0 ? Math.floor(n) : undefined));
            }}
          />
        </label>
      </div>
      <PromptDialog
        open={asking === "property"}
        title={t("bases.columns.newProperty")}
        submitLabel={t("bases.columns.addColumn")}
        fields={[
          {
            id: "name",
            label: t("bases.columns.propertyName"),
            hint: t("bases.columns.propertyHint"),
            required: true,
          },
        ]}
        onClose={() => setAsking(null)}
        onSubmit={({ name }) => {
          setAsking(null);
          setOrder([...shown, name!.trim()]);
        }}
      />
      <PromptDialog
        open={asking === "formula"}
        title={t("bases.columns.newFormula")}
        submitLabel={t("bases.columns.addColumn")}
        fields={[
          { id: "name", label: t("bases.columns.formulaName"), required: true },
          {
            id: "expr",
            label: t("bases.columns.formulaExpr"),
            hint: t("bases.columns.formulaHint"),
            required: true,
          },
        ]}
        onClose={() => setAsking(null)}
        onSubmit={({ name, expr }) => {
          setAsking(null);
          void configure((b, v) => {
            b.formulas = { ...b.formulas, [name!.trim()]: expr!.trim() };
            v.order = [...shown, `formula.${name!.trim()}`];
          });
        }}
      />
    </div>
  );
}

/** The raw settings of the database, in the same YAML Obsidian Bases uses. */
export function YamlPanel({ source, onSave }: { source: string; onSave: (next: string) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(source);
  useEffect(() => setText(source), [source]);
  return (
    <div className="base-panel">
      <textarea
        className="base-yaml input"
        aria-label={t("bases.yaml.label")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={Math.min(24, Math.max(6, text.split("\n").length + 1))}
      />
      <div className="base-panel-row">
        <Button variant="primary" onClick={() => onSave(text)} disabled={text === source}>
          {t("bases.yaml.apply")}
        </Button>
        <span className="base-hint">{t("bases.yaml.hint")}</span>
      </div>
    </div>
  );
}
