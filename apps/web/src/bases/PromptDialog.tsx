import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog } from "../ui/index.ts";

export interface PromptField {
  id: string;
  label: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  /** The form cannot be submitted while a required field is empty. */
  required?: boolean;
}

interface PromptProps {
  open: boolean;
  title: string;
  submitLabel: string;
  fields: PromptField[];
  /** Shown above the fields. */
  intro?: ReactNode;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => void;
}

/** A small form for a name or two: what a browser `prompt()` would be, as a dialog that can be translated and styled. */
export function PromptDialog({
  open,
  title,
  submitLabel,
  fields,
  intro,
  onClose,
  onSubmit,
}: PromptProps) {
  const { t } = useTranslation();
  const initial = () => Object.fromEntries(fields.map((f) => [f.id, f.initial ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  useEffect(() => {
    if (open) setValues(initial());
    // Reset when the dialog opens, not on every render of its caller.
  }, [open]);

  const ready = fields.every((f) => !f.required || (values[f.id] ?? "").trim() !== "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onSubmit(values);
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
          <Button variant="primary" type="submit" form="base-prompt" disabled={!ready}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="base-prompt" className="form" onSubmit={submit} noValidate>
        {intro}
        {fields.map((field, i) => (
          <label className="field" key={field.id}>
            {field.label}
            <input
              {...(i === 0 ? { "data-autofocus": true } : {})}
              className="input"
              value={values[field.id] ?? ""}
              placeholder={field.placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
            />
            {field.hint && <span className="muted base-hint">{field.hint}</span>}
          </label>
        ))}
      </form>
    </Dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}

/** "Really?" for removing a view. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onClose,
  onConfirm,
}: ConfirmProps) {
  const { t } = useTranslation();
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
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{message}</p>
    </Dialog>
  );
}
