import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../ui/index.ts";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

/** A labelled text input with an optional hint and error line. */
export function TextField({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? noteId : undefined}
        {...input}
      />
      {(error || hint) && (
        <p
          id={noteId}
          className={error ? "field-error" : "muted"}
          role={error ? "alert" : undefined}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

/** Centred card for the pages shown before anyone is signed in. */
export function AuthCard({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="page auth-page">
      <main className="auth-card">
        <span className="brand">
          <img src="/icons/palimvo.svg" alt="" width="28" height="28" />
          {t("common.appName")}
        </span>
        <h1>{title}</h1>
        {intro && <p className="muted">{intro}</p>}
        {children}
      </main>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="form-error" role="alert">
      <Icon name="warning" />
      {message}
    </p>
  );
}
