import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { changePassword, listSessions, revokeSession } from "../api/auth.ts";
import { describeError } from "../api/errors.ts";
import { useAsync } from "../app/useAsync.ts";
import { FormError, TextField } from "../auth/forms.tsx";
import { useSession } from "../auth/session.tsx";
import { LanguageSelect } from "../i18n/LanguageSelect.tsx";
import { ThemeChoice } from "../theme/ThemeChoice.tsx";
import { Button, Skeleton, useToast } from "../ui/index.ts";
import { formatTime } from "./format.ts";

const MIN_PASSWORD = 10;

function PasswordForm() {
  const { t } = useTranslation();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const shortPassword =
    next.length < MIN_PASSWORD ? t("setup.passwordShort", { count: MIN_PASSWORD }) : null;
  const mismatch = again !== next ? t("setup.passwordMismatch") : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (shortPassword || mismatch) return;
    setBusy(true);
    setProblem(null);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setAgain("");
      setTouched(false);
      toast.push({ message: t("settings.passwordChanged"), kind: "success" });
    } catch (error) {
      setProblem(describeError(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <h2>{t("settings.passwordTitle")}</h2>
      <TextField
        label={t("settings.currentPassword")}
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
      />
      <TextField
        label={t("settings.newPassword")}
        type="password"
        autoComplete="new-password"
        hint={t("setup.passwordHint", { count: MIN_PASSWORD })}
        error={touched ? shortPassword : null}
        value={next}
        onChange={(event) => setNext(event.target.value)}
      />
      <TextField
        label={t("auth.passwordAgain")}
        type="password"
        autoComplete="new-password"
        error={touched ? mismatch : null}
        value={again}
        onChange={(event) => setAgain(event.target.value)}
      />
      <FormError message={problem} />
      <div>
        <Button variant="primary" type="submit" loading={busy}>
          {t("settings.changePassword")}
        </Button>
      </div>
      <p className="muted">{t("settings.passwordNote")}</p>
    </form>
  );
}

function Sessions() {
  const { t, i18n } = useTranslation();
  const sessions = useAsync((signal) => listSessions({ signal }), "sessions");
  const toast = useToast();
  const revoke = async (id: string) => {
    try {
      await revokeSession(id);
      sessions.reload();
    } catch (error) {
      toast.push({ message: describeError(t, error), kind: "error" });
    }
  };
  return (
    <section className="form" aria-labelledby="sessions-title">
      <h2 id="sessions-title">{t("settings.sessionsTitle")}</h2>
      {sessions.status === "loading" && <Skeleton lines={2} />}
      {sessions.status === "error" && <FormError message={describeError(t, sessions.error)} />}
      {sessions.status === "ready" && (
        <ul className="rows">
          {sessions.data.map((s) => (
            <li key={s.id} className="row">
              <div className="row-main">
                <strong>{s.userAgent ?? t("settings.unknownDevice")}</strong>
                <span className="muted">
                  {t("settings.lastSeen", { time: formatTime(s.lastSeenAt, i18n.language) })}
                </span>
              </div>
              {s.current ? (
                <span className="badge">{t("settings.thisDevice")}</span>
              ) : (
                <Button variant="ghost" onClick={() => void revoke(s.id)}>
                  {t("settings.signOutDevice")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AccountSection() {
  const { t } = useTranslation();
  const { session, signOut } = useSession();
  if (session.status !== "account") return null;
  const { account } = session;
  return (
    <div className="settings-stack">
      <section aria-labelledby="profile-title">
        <h2 id="profile-title">{t("settings.profileTitle")}</h2>
        <dl className="details">
          <dt>{t("auth.displayName")}</dt>
          <dd>{account.displayName}</dd>
          <dt>{t("auth.username")}</dt>
          <dd>{account.username}</dd>
          {account.serverAdmin && (
            <>
              <dt>{t("settings.roleLabel")}</dt>
              <dd>{t("settings.serverAdmin")}</dd>
            </>
          )}
        </dl>
      </section>
      <section className="form" aria-labelledby="look-title">
        <h2 id="look-title">{t("settings.lookTitle")}</h2>
        <LanguageSelect />
        <ThemeChoice />
      </section>
      <PasswordForm />
      <Sessions />
      <div>
        <Button icon="logout" onClick={() => void signOut()}>
          {t("auth.signOut")}
        </Button>
      </div>
    </div>
  );
}
