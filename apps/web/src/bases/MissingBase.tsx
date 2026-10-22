import { useTranslation } from "react-i18next";

/** Shown in place of a `![[name.base]]` that names no file in the vault. */
export function MissingBase({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <div className="base-view embedded">
      <div className="base-error">{t("bases.notFound", { name })}</div>
    </div>
  );
}
