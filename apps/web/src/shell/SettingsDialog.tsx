import { useTranslation } from "react-i18next";
import { LanguageSelect } from "../i18n/LanguageSelect.tsx";
import { ThemeChoice } from "../theme/ThemeChoice.tsx";
import { Link } from "react-router";
import { AccountBar } from "../auth/AccountBar.tsx";
import { useSession } from "../auth/session.tsx";
import { PluginThemeChoice } from "../plugins/pluginTheme.tsx";
import { PluginSettingsSections } from "../plugins/SlotViews.tsx";
import { Dialog } from "../ui/index.ts";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { session } = useSession();
  return (
    <Dialog open={open} onClose={onClose} title={t("nav.settings")}>
      <div className="form">
        <AccountBar />
        <LanguageSelect />
        <ThemeChoice />
        <PluginThemeChoice />
        <PluginSettingsSections />
        {session.status === "account" && (
          <Link to="/settings" onClick={onClose}>
            {t("settings.allSettings")}
          </Link>
        )}
      </div>
    </Dialog>
  );
}
