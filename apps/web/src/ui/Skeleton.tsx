import { useTranslation } from "react-i18next";

/** A grey placeholder shaped like a page of text, announced to screen readers as loading. */
export function Skeleton({ lines = 6 }: { lines?: number }) {
  const { t } = useTranslation();
  return (
    <div className="skeleton" role="status">
      <span className="sr-only">{t("common.loading")}</span>
      <div className="skeleton-line title" aria-hidden="true" />
      {Array.from({ length: lines }, (_, i) => (
        <div className="skeleton-line" key={i} aria-hidden="true" />
      ))}
    </div>
  );
}
