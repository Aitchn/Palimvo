import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { login } from "../api/auth.ts";
import { describeError } from "../api/errors.ts";
import { LanguageSelect } from "../i18n/LanguageSelect.tsx";
import { Button } from "../ui/index.ts";
import { AuthCard, FormError, TextField } from "./forms.tsx";
import { useSession } from "./session.tsx";

/** Only addresses inside this app are followed after signing in. */
export function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/";
}

export function LoginPage() {
  const { t } = useTranslation();
  const { session, signedIn } = useSession();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (session.status === "setup") return <Navigate to="/setup" replace />;
  if (session.status === "account") return <Navigate to={next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const result = await login(username.trim(), password);
      await signedIn(result.account);
    } catch (error) {
      setProblem(describeError(t, error));
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.loginTitle")} intro={t("auth.loginIntro")}>
      <form className="form" onSubmit={submit}>
        <TextField
          label={t("auth.username")}
          value={username}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          onChange={(event) => setUsername(event.target.value)}
        />
        <TextField
          label={t("auth.password")}
          type="password"
          value={password}
          autoComplete="current-password"
          required
          onChange={(event) => setPassword(event.target.value)}
        />
        <FormError message={problem} />
        <Button variant="primary" type="submit" loading={busy}>
          {t("auth.signIn")}
        </Button>
      </form>
      <p className="muted">{t("auth.noAccountHint")}</p>
      <LanguageSelect />
    </AuthCard>
  );
}
