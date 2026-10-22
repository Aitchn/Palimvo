import { useRef, useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { useTranslation } from "react-i18next";
import { isValidVaultId } from "@palimvo/core";
import { getSetupStatus, runSetup } from "../api/auth.ts";
import { describeError } from "../api/errors.ts";
import { useAsync } from "../app/useAsync.ts";
import { LanguageSelect } from "../i18n/LanguageSelect.tsx";
import { ThemeChoice } from "../theme/ThemeChoice.tsx";
import { Button, Skeleton } from "../ui/index.ts";
import { AuthCard, FormError, TextField } from "./forms.tsx";
import { useSession } from "./session.tsx";

type Step = "welcome" | "account" | "vault";
const MIN_PASSWORD = 10;

/** The first-time wizard: language, administrator account, first vault. */
export function SetupPage() {
  const { t } = useTranslation();
  const { session, signedIn } = useSession();
  const status = useAsync((signal) => getSetupStatus({ signal }), "setup-status");
  const [step, setStep] = useState<Step>("welcome");
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [vaultId, setVaultId] = useState("main");
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // Set just before the new session is recorded, so that change does not send us to "/" first.
  const landing = useRef<string | null>(null);

  if (landing.current) return <Navigate to={landing.current} replace />;
  if (session.status === "account" || session.status === "guest")
    return <Navigate to="/" replace />;
  if (status.status === "loading")
    return (
      <AuthCard title={t("setup.title")}>
        <Skeleton lines={3} />
      </AuthCard>
    );
  if (status.status === "error")
    return (
      <AuthCard title={t("setup.title")}>
        <FormError message={describeError(t, status.error)} />
        <Button onClick={status.reload}>{t("common.retry")}</Button>
      </AuthCard>
    );
  if (!status.data.required) return <Navigate to="/login" replace />;
  const needsCode = status.data.needsCode;

  const usernameProblem = username.trim() === "" ? t("setup.usernameRequired") : null;
  const passwordProblem =
    password.length < MIN_PASSWORD ? t("setup.passwordShort", { count: MIN_PASSWORD }) : null;
  const againProblem = again !== password ? t("setup.passwordMismatch") : null;
  const vaultProblem = isValidVaultId(vaultId.trim()) ? null : t("setup.vaultInvalid");
  const codeProblem = needsCode && code.trim() === "" ? t("setup.codeRequired") : null;

  const toAccount = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (codeProblem) return;
    setTouched(false);
    setStep("account");
  };
  const toVault = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (usernameProblem || passwordProblem || againProblem) return;
    setTouched(false);
    setStep("vault");
  };
  const finish = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (vaultProblem) return;
    setBusy(true);
    setProblem(null);
    try {
      const id = vaultId.trim();
      const result = await runSetup({
        ...(needsCode ? { code: code.trim() } : {}),
        username: username.trim(),
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        vault: { id, sample },
      });
      landing.current = `/v/${encodeURIComponent(id)}`;
      await signedIn(result.account);
    } catch (error) {
      setProblem(describeError(t, error));
      setBusy(false);
    }
  };

  const steps: Step[] = ["welcome", "account", "vault"];
  const progress = (
    <ol className="steps" aria-label={t("setup.stepsLabel")}>
      {steps.map((id, index) => (
        <li key={id} aria-current={id === step ? "step" : undefined}>
          {t(`setup.step.${id}`, { number: index + 1 })}
        </li>
      ))}
    </ol>
  );

  if (step === "welcome")
    return (
      <AuthCard title={t("setup.title")} intro={t("setup.welcomeIntro")}>
        {progress}
        <form className="form" onSubmit={toAccount} noValidate>
          <LanguageSelect />
          <ThemeChoice />
          {needsCode ? (
            <TextField
              label={t("setup.code")}
              hint={t("setup.codeHint")}
              error={touched ? codeProblem : null}
              value={code}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setCode(event.target.value)}
            />
          ) : (
            <p className="muted">{t("setup.localNote")}</p>
          )}
          <Button variant="primary" type="submit">
            {t("setup.next")}
          </Button>
        </form>
      </AuthCard>
    );

  if (step === "account")
    return (
      <AuthCard title={t("setup.accountTitle")} intro={t("setup.accountIntro")}>
        {progress}
        <form className="form" onSubmit={toVault} noValidate>
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
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setStep("welcome")}>
              {t("common.back")}
            </Button>
            <Button variant="primary" type="submit">
              {t("setup.next")}
            </Button>
          </div>
        </form>
      </AuthCard>
    );

  return (
    <AuthCard title={t("setup.vaultTitle")} intro={t("setup.vaultIntro")}>
      {progress}
      <form className="form" onSubmit={finish} noValidate>
        <TextField
          label={t("setup.vaultName")}
          hint={t("setup.vaultHint")}
          error={touched ? vaultProblem : null}
          value={vaultId}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          onChange={(event) => setVaultId(event.target.value)}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={sample}
            onChange={(event) => setSample(event.target.checked)}
          />
          {t("setup.sample")}
        </label>
        <FormError message={problem} />
        <div className="form-actions">
          <Button variant="ghost" onClick={() => setStep("account")} disabled={busy}>
            {t("common.back")}
          </Button>
          <Button variant="primary" type="submit" loading={busy}>
            {t("setup.finish")}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
