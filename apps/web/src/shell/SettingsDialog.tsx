import { useTranslation } from "react-i18next";
import { LanguageSelect } from "../i18n/LanguageSelect.tsx";
import { ThemeChoice } from "../theme/ThemeChoice.tsx";
import { Dialog } from "../ui/index.ts";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} title={t("nav.settings")}>
      <div className="form">
        <LanguageSelect />
        <ThemeChoice />
      </div>
    </Dialog>
  );
}
