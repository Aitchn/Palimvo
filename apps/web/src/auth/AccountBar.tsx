import { Link, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { Button, Icon } from "../ui/index.ts";
import { useSession } from "./session.tsx";

/** Who is signed in, with the way to their settings and out; guests get a sign-in link. */
export function AccountBar() {
  const { t } = useTranslation();
  const { session, signOut } = useSession();
  const location = useLocation();

  if (session.status === "guest")
    return (
      <Link
        className="btn btn-primary"
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
      >
        {t("auth.signIn")}
      </Link>
    );
  if (session.status !== "account") return null;
  return (
    <div className="account-bar">
      <Link className="account-name" to="/settings/account" aria-label={t("auth.accountSettings")}>
        <Icon name="user" />
        <span>{session.account.displayName}</span>
      </Link>
      <Button
        variant="ghost"
        icon="logout"
        aria-label={t("auth.signOut")}
        onClick={() => void signOut()}
      />
    </div>
  );
}
