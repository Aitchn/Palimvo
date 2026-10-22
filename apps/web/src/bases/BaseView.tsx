import {
  newRowTemplate,
  parseBase,
  setNoteProperty,
  updateBaseSource,
  type BaseColumn,
  type BaseFile,
  type BaseResult,
  type BaseView as BaseViewConfig,
  type CellValue,
} from "@palimvo/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/errors.ts";
import { readFile, writeFile } from "../api/files.ts";
import { queryBase, setProperty } from "../api/bases.ts";
import { Button, Icon, Skeleton } from "../ui/index.ts";
import { BaseRows, groupLabel, type Configure } from "./BaseRows.tsx";
import { ColumnsPanel, YamlPanel } from "./ColumnsPanel.tsx";
import { baseErrorText } from "./errorText.ts";
import { FilterPanel } from "./FilterPanel.tsx";
import { columnLabel } from "./labels.ts";
import { columnChoices, countFilters, parseQuiet, titleOf } from "./model.ts";
import { ConfirmDialog, PromptDialog } from "./PromptDialog.tsx";

/** A .base file, or the YAML of a ```base block inside a note (`onChange` writes it back into the note). */
export type BaseTarget =
  | { kind: "file"; path: string }
  | {
      kind: "inline";
      source: string;
      thisPath?: string | undefined;
      onChange?: ((source: string) => void) | undefined;
    };

interface Props {
  vault: string;
  target: BaseTarget;
  /** View to show first (from `![[db.base#view]]`). */
  initialView?: string | undefined;
  /** Editors may change cells, add notes and change the views. */
  canEdit: boolean;
  onOpen: (path: string) => void;
  /** Opens a [[link]] found in a cell. */
  onOpenLink?: ((target: string) => void) | undefined;
  /** Shown inside a note: compact, with a way to open the database itself. */
  embedded?: boolean | undefined;
}

type Panel = "filters" | "columns" | "yaml" | null;
type Asking =
  | { kind: "addRow" }
  | { kind: "addView" }
  | { kind: "renameView"; index: number }
  | { kind: "deleteView"; index: number }
  | null;

/** How long after an edit the rows are fetched again, and how often while the page is open. */
export const REFRESH_AFTER_EDIT_MS = 300;
export const POLL_MS = 10_000;

/** Table or cards of the notes a database matches, with its views, filters, columns, sorting and grouping. */
export function BaseView({
  vault,
  target,
  initialView,
  canEdit,
  onOpen,
  onOpenLink,
  embedded,
}: Props) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string | null>(
    target.kind === "inline" ? target.source : null,
  );
  const version = useRef<string | null>(null);
  const [view, setView] = useState<string | number>(initialView ?? 0);
  const [result, setResult] = useState<BaseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [tick, setTick] = useState(0);
  const filePath = target.kind === "file" ? target.path : null;
  const thisPath = target.kind === "file" ? target.path : target.thisPath;
  const inlineSource = target.kind === "inline" ? target.source : null;
  const onInlineChange = target.kind === "inline" ? target.onChange : undefined;
  const fail = useCallback((err: unknown) => setError(baseErrorText(t, err)), [t]);

  useEffect(() => {
    if (inlineSource !== null) setSource(inlineSource);
  }, [inlineSource]);

  const loadFile = useCallback(async () => {
    if (!filePath) return;
    try {
      const file = await readFile(vault, filePath);
      version.current = file.version;
      setSource(file.content);
    } catch (err) {
      fail(err);
    }
  }, [vault, filePath, fail]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  // Notes change all the time (people typing, AIs): fetch the rows again every so often.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1);
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) setTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (filePath === null && source === null) return;
    const controller = new AbortController();
    queryBase(
      vault,
      filePath !== null
        ? { path: filePath, view }
        : { source: source!, ...(thisPath ? { thisPath } : {}), view },
      { signal: controller.signal },
    ).then(
      (r) => {
        if (controller.signal.aborted) return;
        setResult(r);
        setError(null);
        // Someone changed the file's settings: the panels need the new text too.
        if (filePath !== null && version.current !== null && r.version !== version.current)
          void loadFile();
      },
      (err: unknown) => {
        if (!controller.signal.aborted) fail(err);
      },
    );
    return () => controller.abort();
  }, [vault, filePath, source, thisPath, view, tick, loadFile, fail]);

  const canConfigure = canEdit && (target.kind === "file" || !!onInlineChange);

  /** Saves the database's settings (to the .base file, or the note's ```base block). */
  const save = useCallback(
    async (next: string) => {
      if (next === source) return;
      if (target.kind === "inline") {
        setSource(next);
        onInlineChange?.(next);
        return;
      }
      try {
        const saved = await writeFile(vault, target.path, next, version.current);
        version.current = saved.version;
        setSource(next);
        setTick((n) => n + 1);
      } catch (err) {
        if (err instanceof ApiError && err.code === "version_conflict")
          setError(t("bases.conflict"));
        else fail(err);
        void loadFile();
      }
    },
    [source, target, onInlineChange, vault, loadFile, fail, t],
  );

  /** Changes the settings of the database and the view being shown, then saves them. */
  const configure: Configure = useCallback(
    async (change) => {
      if (source === null || !result) return;
      let base: BaseFile;
      try {
        base = parseBase(source);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      change(base, base.views[Math.min(result.viewIndex, base.views.length - 1)]!);
      await save(updateBaseSource(source, base));
    },
    [source, result, save],
  );

  const setCell = useCallback(
    async (path: string, column: BaseColumn, value: CellValue) => {
      // Shown right away; the fetch after the write confirms it.
      setResult(
        (r) =>
          r && {
            ...r,
            rows: r.rows.map((row) =>
              row.path === path ? { ...row, cells: { ...row.cells, [column.id]: value } } : row,
            ),
          },
      );
      try {
        await setProperty(vault, path, column.key, value);
      } catch (err) {
        fail(err);
      }
      setTick((n) => n + 1);
    },
    [vault, fail],
  );

  const addRow = useCallback(
    async (name: string) => {
      if (source === null || !result) return;
      let template: ReturnType<typeof newRowTemplate>;
      try {
        template = newRowTemplate(parseBase(source), result.viewIndex);
      } catch {
        template = { properties: {} };
      }
      const here = thisPath?.includes("/") ? thisPath.slice(0, thisPath.lastIndexOf("/")) : "";
      const folder = template.folder ?? here;
      const file = name.trim().replace(/\.md$/i, "");
      const path = `${folder ? `${folder}/` : ""}${file}.md`;
      let content = `# ${file.split("/").pop()}\n`;
      for (const [key, value] of Object.entries(template.properties))
        content = setNoteProperty(content, key, value);
      try {
        await writeFile(vault, path, content, null);
        setTick((n) => n + 1);
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.code === "version_conflict" || err.code === "already_exists")
        )
          setError(t("bases.exists", { path }));
        else fail(err);
      }
    },
    [source, result, thisPath, vault, fail, t],
  );

  const saveYaml = (next: string) => {
    try {
      parseBase(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    void save(next);
  };

  const wrapper = `base-view${embedded ? " embedded nodrag nowheel" : ""}`;
  // Inside a note or card, pointer events must not start dragging the thing around the database.
  const stop = embedded ? (e: React.PointerEvent) => e.stopPropagation() : undefined;

  if (!result) {
    return (
      <div className={wrapper} onPointerDown={stop}>
        {error ? (
          <div className="base-error" role="alert">
            {error}
          </div>
        ) : (
          <Skeleton lines={4} />
        )}
        {error && canConfigure && source !== null && (
          <>
            <Button
              onClick={() => setPanel(panel === "yaml" ? null : "yaml")}
              title={t("bases.yaml.title")}
            >
              YAML
            </Button>
            {panel === "yaml" && <YamlPanel source={source} onSave={saveYaml} />}
          </>
        )}
      </div>
    );
  }

  const active = result.view;
  const base = parseQuiet(source);
  const groupOptions = columnChoices(result).filter((c) => c !== "file.name");
  const sort = active.sort?.[0];
  const filterCount = countFilters(active.filters) + countFilters(base?.filters);
  const viewIcon = (type: BaseViewConfig["type"]) =>
    type === "cards" ? "▤" : type === "plugin" ? "⌁" : "▦";
  const defaultViewName = t("bases.newViewDefault", { n: result.views.length + 1 });

  return (
    <div className={wrapper} onPointerDown={stop}>
      <div className="base-toolbar">
        <div className="base-tabs" role="tablist" aria-label={t("bases.views")}>
          {embedded && filePath && (
            <button
              type="button"
              className="base-open"
              title={t("bases.open")}
              onClick={() => onOpen(filePath)}
            >
              ▦ {titleOf(filePath).replace(/\.base$/i, "")}
            </button>
          )}
          {result.views.map((v, i) => (
            <button
              key={`${i}-${v.name}`}
              type="button"
              role="tab"
              aria-selected={i === result.viewIndex}
              onClick={() => setView(i)}
            >
              {viewIcon(v.type)} {v.name}
            </button>
          ))}
          {canConfigure && (
            <>
              <Button
                variant="ghost"
                aria-label={t("bases.addView")}
                title={t("bases.addView")}
                onClick={() => setAsking({ kind: "addView" })}
              >
                <Icon name="add" />
              </Button>
              <Button
                variant="ghost"
                aria-label={t("bases.renameView")}
                title={t("bases.renameView")}
                onClick={() => setAsking({ kind: "renameView", index: result.viewIndex })}
              >
                <Icon name="edit" />
              </Button>
              {result.views.length > 1 && (
                <Button
                  variant="ghost"
                  aria-label={t("bases.deleteView")}
                  title={t("bases.deleteView")}
                  onClick={() => setAsking({ kind: "deleteView", index: result.viewIndex })}
                >
                  <Icon name="trash" />
                </Button>
              )}
            </>
          )}
        </div>
        <div className="base-controls" hidden={active.type === "plugin" && !canConfigure}>
          {canConfigure && (
            <>
              <select
                className="select"
                aria-label={t("bases.display")}
                value={active.type}
                onChange={(e) =>
                  void configure((_b, v) => (v.type = e.target.value as BaseViewConfig["type"]))
                }
              >
                {active.type === "plugin" && (
                  <option value="plugin">{t("bases.displayPlugin")}</option>
                )}
                <option value="table">{t("bases.displayTable")}</option>
                <option value="cards">{t("bases.displayCards")}</option>
              </select>
              {active.type !== "plugin" && (
                <>
                  <select
                    className="select"
                    aria-label={t("bases.groupBy")}
                    value={active.groupBy?.property ?? ""}
                    onChange={(e) =>
                      void configure(
                        (_b, v) =>
                          (v.groupBy = e.target.value
                            ? { property: e.target.value, direction: "ASC" }
                            : undefined),
                      )
                    }
                  >
                    <option value="">{t("bases.noGrouping")}</option>
                    {groupOptions.map((id) => (
                      <option key={id} value={id}>
                        {t("bases.groupByColumn", { column: columnLabel(t, id, base) })}
                      </option>
                    ))}
                  </select>
                  <Button
                    className={panel === "filters" ? "active" : ""}
                    aria-pressed={panel === "filters"}
                    onClick={() => setPanel(panel === "filters" ? null : "filters")}
                  >
                    {filterCount > 0
                      ? t("bases.filtersCount", { count: filterCount })
                      : t("bases.filters.title")}
                  </Button>
                  <Button
                    className={panel === "columns" ? "active" : ""}
                    aria-pressed={panel === "columns"}
                    onClick={() => setPanel(panel === "columns" ? null : "columns")}
                  >
                    {t("bases.columns.title")}
                  </Button>
                </>
              )}
              <Button
                className={panel === "yaml" ? "active" : ""}
                aria-pressed={panel === "yaml"}
                title={t("bases.yaml.title")}
                onClick={() => setPanel(panel === "yaml" ? null : "yaml")}
              >
                YAML
              </Button>
            </>
          )}
          {canEdit && active.type !== "plugin" && (
            <Button
              icon="add"
              className="base-add-row"
              onClick={() => setAsking({ kind: "addRow" })}
            >
              {t("bases.addRow")}
            </Button>
          )}
          {active.type !== "plugin" && (
            <span className="base-count">
              {result.total === result.rows.length
                ? t("bases.count", { count: result.total })
                : t("bases.countOf", { shown: result.rows.length, total: result.total })}
            </span>
          )}
        </div>
      </div>
      {error && (
        <div className="base-error" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {result.errors.length > 0 && <div className="base-error">{result.errors.join("; ")}</div>}
      {panel === "filters" && source !== null && (
        <FilterPanel
          base={base}
          view={active}
          available={result.available}
          onChange={(scope, filters) =>
            void configure((b, v) =>
              scope === "all" ? (b.filters = filters) : (v.filters = filters),
            )
          }
        />
      )}
      {panel === "columns" && (
        <ColumnsPanel result={result} source={source} configure={configure} />
      )}
      {panel === "yaml" && source !== null && <YamlPanel source={source} onSave={saveYaml} />}
      <div className="base-body">
        {active.type === "plugin" ? (
          <div className="base-empty">{t("bases.pluginUnavailable")}</div>
        ) : result.rows.length === 0 ? (
          <div className="base-empty">{t("bases.empty")}</div>
        ) : result.groups && active.type === "cards" ? (
          result.groups.map((g) => (
            <section key={g.label} className="base-group">
              <h4>
                {groupLabel(g.label, active.groupBy!.property, t("bases.noValue"))}{" "}
                <span>{g.rows.length}</span>
              </h4>
              <BaseRows
                result={result}
                indices={g.rows}
                canEdit={canEdit}
                configure={canConfigure ? configure : undefined}
                sort={sort}
                onOpen={onOpen}
                onOpenLink={onOpenLink}
                onSet={setCell}
              />
            </section>
          ))
        ) : (
          <BaseRows
            result={result}
            indices={result.rows.map((_, i) => i)}
            {...(result.groups ? { groups: result.groups } : {})}
            canEdit={canEdit}
            configure={canConfigure ? configure : undefined}
            sort={sort}
            onOpen={onOpen}
            onOpenLink={onOpenLink}
            onSet={setCell}
          />
        )}
      </div>
      <PromptDialog
        open={asking?.kind === "addRow"}
        title={t("bases.addRowTitle")}
        submitLabel={t("bases.create")}
        fields={[
          {
            id: "name",
            label: t("bases.addRowName"),
            initial: t("bases.addRowDefault"),
            hint: t("bases.addRowHint"),
            required: true,
          },
        ]}
        onClose={() => setAsking(null)}
        onSubmit={({ name }) => {
          setAsking(null);
          void addRow(name!);
        }}
      />
      <PromptDialog
        open={asking?.kind === "addView"}
        title={t("bases.addView")}
        submitLabel={t("bases.create")}
        fields={[
          { id: "name", label: t("bases.viewName"), initial: defaultViewName, required: true },
        ]}
        onClose={() => setAsking(null)}
        onSubmit={({ name }) => {
          setAsking(null);
          void configure((b, current) => {
            b.views.push({
              type: current.type,
              name: name!.trim(),
              order: current.order ?? result.columns.map((c) => c.id),
              ...(current.type === "plugin" && current.plugin
                ? { plugin: { ...current.plugin } }
                : {}),
            });
            setView(b.views.length - 1);
          });
        }}
      />
      <PromptDialog
        open={asking?.kind === "renameView"}
        title={t("bases.renameView")}
        submitLabel={t("common.save")}
        fields={[
          {
            id: "name",
            label: t("bases.viewName"),
            initial: asking?.kind === "renameView" ? (result.views[asking.index]?.name ?? "") : "",
            required: true,
          },
        ]}
        onClose={() => setAsking(null)}
        onSubmit={({ name }) => {
          const index = asking?.kind === "renameView" ? asking.index : -1;
          setAsking(null);
          void configure((b) => {
            const target = b.views[index];
            if (target) target.name = name!.trim();
          });
        }}
      />
      <ConfirmDialog
        open={asking?.kind === "deleteView"}
        title={t("bases.deleteView")}
        message={t("bases.deleteConfirm", {
          name: asking?.kind === "deleteView" ? (result.views[asking.index]?.name ?? "") : "",
        })}
        confirmLabel={t("common.delete")}
        onClose={() => setAsking(null)}
        onConfirm={() => {
          const index = asking?.kind === "deleteView" ? asking.index : -1;
          setAsking(null);
          void configure((b) => {
            if (b.views.length > 1) b.views.splice(index, 1);
            setView(0);
          });
        }}
      />
    </div>
  );
}
