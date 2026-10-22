import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import { Button, Dialog } from "../ui/index.ts";
import { nameProblem } from "./model.ts";

interface PromptProps {
  open: boolean;
  title: string;
  /** Where the item will be, shown under the field (`""`: the vault root). */
  folder: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  /** Throw to keep the dialog open and show the error under the field. */
  onSubmit: (name: string) => Promise<void>;
}

/** Asks for one file or folder name. */
export function NamePrompt({
  open,
  title,
  folder,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: PromptProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial);
    setProblem(null);
    setBusy(false);
    // Select the name without its extension, as file managers do.
    const timer = setTimeout(() => {
      const dot = initial.lastIndexOf(".");
      input.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }, 0);
    return () => clearTimeout(timer);
  }, [open, initial]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const bad = nameProblem(trimmed);
    if (bad) {
      setProblem(t(bad === "empty" ? "files.nameEmpty" : "files.nameInvalid"));
      return;
    }
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } catch (error) {
      setProblem(describeError(t, error));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="name-prompt" loading={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="name-prompt" className="form" onSubmit={submit} noValidate>
        <label className="field">
          {t("files.nameLabel")}
          <input
            ref={input}
            data-autofocus
            className="input"
            value={name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem ? true : undefined}
            aria-describedby="name-prompt-note"
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
          />
        </label>
        <p
          id="name-prompt-note"
          className={problem ? "field-error" : "muted"}
          role={problem ? "alert" : undefined}
        >
          {problem ?? t("files.location", { folder: `/${folder}` })}
        </p>
      </form>
    </Dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  name: string;
  isFolder: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

/** "Delete X?" for a file or a folder with everything in it. */
export function ConfirmDelete({ open, name, isFolder, onClose, onConfirm }: ConfirmProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setBusy(false);
      setProblem(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("files.deleteTitle", { name })}
      footer={
        <>
          <Button variant="ghost" data-autofocus onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } catch (error) {
                setProblem(describeError(t, error));
                setBusy(false);
              }
            }}
          >
            {t("common.delete")}
          </Button>
        </>
      }
    >
      <p>{t(isFolder ? "files.deleteFolderBody" : "files.deleteFileBody")}</p>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
