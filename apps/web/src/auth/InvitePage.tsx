import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { acceptInvite, previewInvite } from "../api/auth.ts";
import { describeError } from "../api/errors.ts";
import { useAsync } from "../app/useAsync.ts";
import { LanguageSelect } from "../i18n/LanguageSelect.tsx";
import { Button, Skeleton } from "../ui/index.ts";
import { AuthCard, FormError, TextField } from "./forms.tsx";
import { useSession } from "./session.tsx";

const MIN_PASSWORD = 10;

/** `/invite/:token`: someone follows an invite link and makes their account. */
export function InvitePage() {
  const { t } = useTranslation();
  const { token = "" } = useParams();
  const { session, signedIn } = useSession();
  const navigate = useNavigate();
  const invite = useAsync((signal) => previewInvite(token, { signal }), `invite:${token}`);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (session.status === "setup") return <Navigate to="/setup" replace />;
  if (invite.status === "loading")
    return (
      <AuthCard title={t("invite.title")}>
        <Skeleton lines={3} />
      </AuthCard>
    );
  if (invite.status === "error")
    return (
      <AuthCard title={t("invite.title")}>
        <FormError message={describeError(t, invite.error)} />
        <Link className="btn btn-secondary" to="/login">
          {t("auth.signIn")}
        </Link>
      </AuthCard>
    );

  const usernameProblem = username.trim() === "" ? t("setup.usernameRequired") : null;
  const passwordProblem =
    password.length < MIN_PASSWORD ? t("setup.passwordShort", { count: MIN_PASSWORD }) : null;
  const againProblem = again !== password ? t("setup.passwordMismatch") : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (usernameProblem || passwordProblem || againProblem) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await acceptInvite(token, {
        username: username.trim(),
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      await signedIn(result.account);
      const first = invite.data.vaults[0];
      navigate(first ? `/v/${encodeURIComponent(first.vaultId)}` : "/", { replace: true });
    } catch (error) {
      setProblem(describeError(t, error));
      setBusy(false);
    }
  };

  const { roles, vaults, note } = invite.data;
  return (
    <AuthCard title={t("invite.title")} intro={t("invite.intro")}>
      {note && <p className="invite-note">{note}</p>}
      {(vaults.length > 0 || roles.length > 0) && (
        <dl className="details">
          {vaults.length > 0 && (
            <>
              <dt>{t("invite.vaults")}</dt>
              <dd>{vaults.map((v) => v.vaultId).join(", ")}</dd>
            </>
          )}
          {roles.length > 0 && (
            <>
              <dt>{t("invite.roles")}</dt>
              <dd>
                {roles.map((r) => (
                  <span
                    key={r.id}
                    className="role-chip"
                    style={r.color ? ({ "--role": r.color } as never) : undefined}
                  >
                    {r.name}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}
      <form className="form" onSubmit={submit} noValidate>
        <TextField
          label={t("auth.username")}
          error={touched ? usernameProblem : null}
          value={username}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          onChange={(event) => setUsername(event.target.value)}
        />
        <TextField
          label={t("auth.displayName")}
          hint={t("auth.displayNameHint")}
          value={displayName}
          autoComplete="name"
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <TextField
          label={t("auth.password")}
          type="password"
          hint={t("setup.passwordHint", { count: MIN_PASSWORD })}
          error={touched ? passwordProblem : null}
          value={password}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextField
          label={t("auth.passwordAgain")}
          type="password"
          error={touched ? againProblem : null}
          value={again}
          autoComplete="new-password"
          onChange={(event) => setAgain(event.target.value)}
        />
        <FormError message={problem} />
        <Button variant="primary" type="submit" loading={busy}>
          {t("invite.join")}
        </Button>
      </form>
      <LanguageSelect />
    </AuthCard>
  );
}
