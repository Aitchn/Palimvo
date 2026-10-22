import { NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { useServerCan, useSession } from "../auth/session.tsx";
import { ThemeMenu } from "../theme/ThemeMenu.tsx";
import { Icon } from "../ui/index.ts";
import { Link } from "react-router";

/** `/settings/*`: the signed-in person's own settings and, with permission, the administration pages. */
export function SettingsPage() {
  const { t } = useTranslation();
  const { session } = useSession();
  const location = useLocation();
  const canUsers = useServerCan("users.manage");

  if (session.status === "guest")
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (session.status !== "account") return <Navigate to="/" replace />;

  const links = [
    { to: "/settings/account", label: t("settings.account"), show: true },
    { to: "/settings/vaults", label: t("vaults.title"), show: true },
    { to: "/settings/users", label: t("users.title"), show: canUsers },
  ];

  return (
    <div className="page">
      <header className="page-bar">
        <Link to="/" className="brand">
          <img src="/icons/palimvo.svg" alt="" width="28" height="28" />
          {t("common.appName")}
        </Link>
        <ThemeMenu placement="below" />
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("settings.sections")}>
          <Link to="/" className="settings-back">
            <Icon name="chevron" style={{ transform: "rotate(180deg)" }} />
            {t("settings.backToApp")}
          </Link>
          {links
            .filter((l) => l.show)
            .map((l) => (
              <NavLink key={l.to} to={l.to}>
                {l.label}
              </NavLink>
            ))}
        </nav>
        <main className="settings-main">
          <h1>{t("nav.settings")}</h1>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
