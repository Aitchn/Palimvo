import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { describeError } from "../api/errors.ts";
import { listVaults } from "../api/vaults.ts";
import { LanguageSelect } from "../i18n/LanguageSelect.tsx";
import { ThemeMenu } from "../theme/ThemeMenu.tsx";
import { Button, Icon, Skeleton } from "../ui/index.ts";
import { useAsync } from "./useAsync.ts";

function Problem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="state" role="alert">
      <p>{describeError(t, error)}</p>
      <Button onClick={onRetry}>{t("common.retry")}</Button>
    </div>
  );
}

/** `/`: the vaults this server holds. */
export function HomePage() {
  const { t } = useTranslation();
  const vaults = useAsync((signal) => listVaults({ signal }), "vaults");
  return (
    <div className="page">
      <header className="page-bar">
        <span className="brand">
          <img src="/icons/palimvo.svg" alt="" width="28" height="28" />
          {t("common.appName")}
        </span>
        <ThemeMenu placement="below" />
      </header>
      <main className="page-main">
        <h1>{t("shell.vaultsTitle")}</h1>
        {vaults.status === "loading" && <Skeleton lines={3} />}
        {vaults.status === "error" && <Problem error={vaults.error} onRetry={vaults.reload} />}
        {vaults.status === "ready" &&
          (vaults.data.length === 0 ? (
            <p className="muted">{t("shell.vaultsEmpty")}</p>
          ) : (
            <ul className="vault-list">
              {vaults.data.map((vault) => (
                <li key={vault.id}>
                  <Link
                    to={`/v/${encodeURIComponent(vault.id)}`}
                    aria-label={t("shell.openVault", { name: vault.name })}
                  >
                    <Icon name="files" />
                    <span>{vault.name}</span>
                    <Icon name="chevron" />
                  </Link>
                </li>
              ))}
            </ul>
          ))}
        <div className="page-language">
          <LanguageSelect />
        </div>
      </main>
    </div>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="page">
      <main className="page-main state">
        <h1>{t("shell.notFoundTitle")}</h1>
        <p className="muted">{t("shell.notFoundBody")}</p>
        <Link className="btn btn-primary" to="/">
          {t("shell.backHome")}
        </Link>
      </main>
    </div>
  );
}
