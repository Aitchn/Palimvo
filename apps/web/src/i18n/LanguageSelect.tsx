import { useId } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LOCALES, isLocale, type Locale } from "@palimvo/i18n/negotiate";
import { chooseLocale } from "./index.ts";

/** Each language is named in itself, so someone who cannot read the current one can still find theirs. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
};

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const current = isLocale(i18n.language) ? i18n.language : "en";
  return (
    <div className="field">
      <label htmlFor={id}>{t("language.label")}</label>
      <select
        id={id}
        className="select"
        value={current}
        onChange={(event) => {
          if (isLocale(event.target.value)) void chooseLocale(event.target.value, i18n);
        }}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale} lang={locale}>
            {LOCALE_NAMES[locale]}
          </option>
        ))}
      </select>
    </div>
  );
}
