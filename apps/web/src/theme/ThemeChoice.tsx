import { useTranslation } from "react-i18next";
import { Icon } from "../ui/index.ts";
import { useTheme, type ThemePreference } from "./theme.ts";

const OPTIONS: ThemePreference[] = ["system", "light", "dark"];

/** Segmented control for the settings dialog. */
export function ThemeChoice() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  return (
    <div className="field">
      <span id="theme-choice-label">{t("theme.label")}</span>
      <div className="segmented" role="radiogroup" aria-labelledby="theme-choice-label">
        {OPTIONS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={preference === value}
            className="segmented-item"
            onClick={() => setPreference(value)}
          >
            <Icon name={value === "system" ? "monitor" : value === "light" ? "sun" : "moon"} />
            {t(`theme.${value}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
