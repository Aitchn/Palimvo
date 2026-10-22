import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ThemeMenu } from "../theme/ThemeMenu.tsx";
import { Button, Icon } from "../ui/index.ts";

interface Props {
  /** Whether the sidebar is showing; the files button reflects and toggles it. */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

/** The narrow icon column on the left edge. */
export function Rail({ sidebarOpen, onToggleSidebar, onOpenSettings }: Props) {
  const { t } = useTranslation();
  return (
    <nav className="rail" aria-label={t("nav.main")}>
      <Link to="/" className="rail-brand" aria-label={t("nav.vaults")} title={t("nav.vaults")}>
        <img src="/icons/palimvo.svg" alt="" width="28" height="28" />
      </Link>
      <div className="rail-group">
        <button
          type="button"
          className="rail-item"
          aria-pressed={sidebarOpen}
          aria-label={t("nav.files")}
          title={t("nav.files")}
          onClick={onToggleSidebar}
        >
          <Icon name="files" />
        </button>
      </div>
      <div className="rail-spacer" />
      <div className="rail-group">
        <ThemeMenu />
        <Button
          variant="ghost"
          icon="settings"
          aria-label={t("nav.settings")}
          onClick={onOpenSettings}
        />
      </div>
    </nav>
  );
}
