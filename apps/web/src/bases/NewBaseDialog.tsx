import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import { nameProblem } from "../files/model.ts";
import { Button, Dialog } from "../ui/index.ts";
import { newBaseSource } from "./model.ts";

type Source = "all" | "folder" | "tag";

interface Props {
  open: boolean;
  /** Where the file will be (`""`: the vault root). */
  folder: string;
  /** Folders of the vault, to pick the notes from. */
  folders: readonly string[];
  onClose: () => void;
  /** Writes the file; throw to keep the dialog open and show the error. */
  onCreate: (name: string, content: string) => Promise<void>;
}

/** Makes a `.base` file: which notes are its rows, how they are shown, which properties are its columns. */
export function NewBaseDialog({ open, folder, folders, onClose, onCreate }: Props) {
  const { t } = useTranslation();
  const listId = useId();
  const [name, setName] = useState("");
  const [source, setSource] = useState<Source>("folder");
  const [value, setValue] = useState("");
  const [type, setType] = useState<"table" | "cards">("table");
  const [properties, setProperties] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(t("bases.wizard.defaultName"));
    setSource(folder ? "folder" : "all");
    setValue(folder);
    setType("table");
    setProperties("");
    setProblem(null);
    setBusy(false);
    // Start over each time the dialog opens, not when the caller re-renders.
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const bad = nameProblem(trimmed);
    if (bad) {
      setProblem(t(bad === "empty" ? "files.nameEmpty" : "files.nameInvalid"));
      return;
    }
    const columns = [
      "file.name",
      ...properties
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ];
    if (columns.length === 1) columns.push("file.tags", "file.mtime");
    const content = newBaseSource({
      ...(source === "folder" && value.trim()
        ? { folder: value.trim().replace(/^\/+|\/+$/g, "") }
        : {}),
      ...(source === "tag" && value.trim() ? { tag: value.trim() } : {}),
      columns,
      viewName: type === "cards" ? t("bases.displayCards") : t("bases.displayTable"),
      type,
    });
    setBusy(true);
    try {
      await onCreate(/\.base$/i.test(trimmed) ? trimmed : `${trimmed}.base`, content);
    } catch (error) {
      setProblem(describeError(t, error));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("bases.wizard.title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="new-base" loading={busy}>
            {t("files.create")}
          </Button>
        </>
      }
    >
      <form id="new-base" className="form" onSubmit={submit} noValidate>
        <label className="field">
          {t("files.nameLabel")}
          <input
            data-autofocus
            className="input"
            value={name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
          />
        </label>
        <label className="field">
          {t("bases.wizard.source")}
          <select
            className="select"
            value={source}
            onChange={(e) => setSource(e.target.value as Source)}
          >
            <option value="folder">{t("bases.wizard.sourceFolder")}</option>
            <option value="tag">{t("bases.wizard.sourceTag")}</option>
            <option value="all">{t("bases.wizard.sourceAll")}</option>
          </select>
        </label>
        {source !== "all" && (
          <label className="field">
            {source === "folder" ? t("bases.filters.kindFolder") : t("bases.filters.kindTag")}
            <input
              className="input"
              list={source === "folder" ? listId : undefined}
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder={t(
                source === "folder"
                  ? "bases.filters.folderPlaceholder"
                  : "bases.filters.tagPlaceholder",
              )}
              onChange={(e) => setValue(e.target.value)}
            />
            <datalist id={listId}>
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </label>
        )}
        <label className="field">
          {t("bases.wizard.type")}
          <select
            className="select"
            value={type}
            onChange={(e) => setType(e.target.value as "table" | "cards")}
          >
            <option value="table">{t("bases.displayTable")}</option>
            <option value="cards">{t("bases.displayCards")}</option>
          </select>
        </label>
        <label className="field">
          {t("bases.wizard.properties")}
          <input
            className="input"
            value={properties}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("bases.wizard.propertiesPlaceholder")}
            onChange={(e) => setProperties(e.target.value)}
          />
        </label>
        <p className={problem ? "field-error" : "muted"} role={problem ? "alert" : undefined}>
          {problem ?? t("files.location", { folder: `/${folder}` })}
        </p>
      </form>
    </Dialog>
  );
}
