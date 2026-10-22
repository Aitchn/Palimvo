import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { fileKind, type HomeConfig, type HomeWidget, type HomeWidgetType } from "@palimvo/core";
import { ApiError, describeError } from "../api/errors.ts";
import { putHome, type HomeState } from "../api/home.ts";
import { Button, Dialog, Icon, useToast } from "../ui/index.ts";

interface Props {
  open: boolean;
  vault: string;
  state: HomeState;
  /** Every file of the vault, to choose notes and databases from. */
  files: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}

const SINGLE = ["activity", "proposals", "pinned"] as const;

function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

function uniqueId(base: string, taken: readonly HomeWidget[]): string {
  const ids = new Set(taken.map((w) => w.id));
  if (!ids.has(base)) return base;
  for (let n = 2; ; n++) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Lets someone with the vault-settings right choose and order the blocks of the home page, and what is pinned. */
export function HomeSettingsDialog({ open, vault, state, files, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [draft, setDraft] = useState<HomeConfig>(state.config);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pinChoice, setPinChoice] = useState("");
  const [baseChoice, setBaseChoice] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(state.config);
    setBusy(false);
    setProblem(null);
    setPinChoice("");
    setBaseChoice("");
  }, [open, state]);

  const notes = files.filter((p) => fileKind(p) === "markdown");
  const bases = files.filter((p) => fileKind(p) === "base");
  const has = (type: HomeWidgetType) => draft.widgets.some((w) => w.type === type);
  const setWidgets = (widgets: HomeWidget[]) => setDraft({ ...draft, widgets });

  const label = (w: HomeWidget): string =>
    w.type === "base"
      ? t("home.settings.blockBase", { path: w.path })
      : w.type === "plugin"
        ? t("home.settings.blockPlugin", { plugin: w.plugin })
        : t(`home.settings.block.${w.type}`);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await putHome(vault, draft, state.version);
      toast.push({ message: t("home.settings.saved"), kind: "success" });
      onSaved();
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.code === "version_conflict"
          ? t("home.settings.conflict")
          : describeError(t, error),
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("home.customize")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="home-settings" loading={busy}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id="home-settings" className="form home-settings" onSubmit={submit} noValidate>
        <fieldset className="home-set">
          <legend>{t("home.settings.blocks")}</legend>
          <ol className="home-order">
            {draft.widgets.map((w, i) => (
              <li key={w.id}>
                <span>{label(w)}</span>
                <span className="home-order-actions">
                  <Button
                    variant="ghost"
                    aria-label={t("home.settings.moveUp", { name: label(w) })}
                    disabled={i === 0}
                    onClick={() => setWidgets(move(draft.widgets, i, i - 1))}
                  >
                    <Icon name="caret" style={{ transform: "rotate(180deg)" }} />
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={t("home.settings.moveDown", { name: label(w) })}
                    disabled={i === draft.widgets.length - 1}
                    onClick={() => setWidgets(move(draft.widgets, i, i + 1))}
                  >
                    <Icon name="caret" />
                  </Button>
                  <Button
                    variant="ghost"
                    icon="trash"
                    aria-label={t("home.settings.remove", { name: label(w) })}
                    onClick={() => setWidgets(draft.widgets.filter((x) => x.id !== w.id))}
                  />
                </span>
              </li>
            ))}
          </ol>
          <div className="home-add">
            {SINGLE.filter((type) => !has(type)).map((type) => (
              <Button
                key={type}
                variant="secondary"
                icon="add"
                onClick={() =>
                  setWidgets([...draft.widgets, { id: uniqueId(type, draft.widgets), type }])
                }
              >
                {t(`home.settings.block.${type}`)}
              </Button>
            ))}
          </div>
          {bases.length > 0 && (
            <div className="home-add">
              <select
                className="input"
                aria-label={t("home.settings.chooseBase")}
                value={baseChoice}
                onChange={(event) => setBaseChoice(event.target.value)}
              >
                <option value="">{t("home.settings.chooseBase")}</option>
                {bases.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                icon="add"
                disabled={!baseChoice}
                onClick={() => {
                  setWidgets([
                    ...draft.widgets,
                    { id: uniqueId("base", draft.widgets), type: "base", path: baseChoice },
                  ]);
                  setBaseChoice("");
                }}
              >
                {t("home.settings.addBase")}
              </Button>
            </div>
          )}
        </fieldset>

        <fieldset className="home-set">
          <legend>{t("home.settings.pinned")}</legend>
          {draft.pinned.length === 0 && <p className="muted">{t("home.pinned.empty")}</p>}
          <ol className="home-order">
            {draft.pinned.map((path, i) => (
              <li key={path}>
                <span>{path}</span>
                <span className="home-order-actions">
                  <Button
                    variant="ghost"
                    aria-label={t("home.settings.moveUp", { name: path })}
                    disabled={i === 0}
                    onClick={() => setDraft({ ...draft, pinned: move(draft.pinned, i, i - 1) })}
                  >
                    <Icon name="caret" style={{ transform: "rotate(180deg)" }} />
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={t("home.settings.moveDown", { name: path })}
                    disabled={i === draft.pinned.length - 1}
                    onClick={() => setDraft({ ...draft, pinned: move(draft.pinned, i, i + 1) })}
                  >
                    <Icon name="caret" />
                  </Button>
                  <Button
                    variant="ghost"
                    icon="trash"
                    aria-label={t("home.settings.unpin", { name: path })}
                    onClick={() =>
                      setDraft({ ...draft, pinned: draft.pinned.filter((p) => p !== path) })
                    }
                  />
                </span>
              </li>
            ))}
          </ol>
          <div className="home-add">
            <select
              className="input"
              aria-label={t("home.settings.choosePin")}
              value={pinChoice}
              onChange={(event) => setPinChoice(event.target.value)}
            >
              <option value="">{t("home.settings.choosePin")}</option>
              {notes
                .filter((p) => !draft.pinned.includes(p))
                .map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
            </select>
            <Button
              variant="secondary"
              icon="pin"
              disabled={!pinChoice}
              onClick={() => {
                setDraft({ ...draft, pinned: [...draft.pinned, pinChoice] });
                setPinChoice("");
              }}
            >
              {t("home.settings.pin")}
            </Button>
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="home-start">{t("home.settings.startHere")}</label>
          <select
            id="home-start"
            className="input"
            value={draft.publicNote ?? ""}
            onChange={(event) => setDraft({ ...draft, publicNote: event.target.value || null })}
          >
            <option value="">{t("home.settings.startNone")}</option>
            {notes.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span className="muted">{t("home.settings.startHereHelp")}</span>
        </div>

        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
      </form>
    </Dialog>
  );
}
