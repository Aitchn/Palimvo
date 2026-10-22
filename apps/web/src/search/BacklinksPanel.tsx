import { useTranslation } from "react-i18next";
import { basename, dirname } from "@palimvo/core";
import { describeError } from "../api/errors.ts";
import { backlinksOf, linksOf } from "../api/search.ts";
import { useAsync } from "../app/useAsync.ts";
import { Button, Skeleton } from "../ui/index.ts";

interface Props {
  vault: string;
  path: string;
  /** Changes when the vault's files changed, so the lists are fetched again. */
  revision: number;
  onOpen: (path: string) => void;
}

/** The files that link to the open file, and the links it contains. */
export function BacklinksPanel({ vault, path, revision, onOpen }: Props) {
  const { t } = useTranslation();
  const links = useAsync(async (signal) => {
    const [backlinks, outgoing] = await Promise.all([
      backlinksOf(vault, path, { signal }),
      linksOf(vault, path, { signal }),
    ]);
    return { backlinks, outgoing };
  }, `links:${vault}:${path}:${revision}`);

  if (links.status === "loading") return <Skeleton lines={4} />;
  if (links.status === "error") {
    return (
      <div className="state" role="alert">
        <p>{describeError(t, links.error)}</p>
        <Button onClick={links.reload}>{t("common.retry")}</Button>
      </div>
    );
  }
  const { backlinks, outgoing } = links.data;
  return (
    <section className="link-panel" aria-label={t("backlinks.title")}>
      <h2 className="link-heading">{t("backlinks.linkedFrom", { count: backlinks.length })}</h2>
      {backlinks.length === 0 ? (
        <p className="muted">{t("backlinks.none")}</p>
      ) : (
        <ul className="link-list">
          {backlinks.map((link) => (
            <li key={link.path}>
              <button type="button" className="link-item" onClick={() => onOpen(link.path)}>
                <span className="link-item-title">{basename(link.path)}</span>
                {dirname(link.path) !== "" && (
                  <span className="muted link-item-detail">{dirname(link.path)}</span>
                )}
                {link.lines.map((line) => (
                  <span key={line.line} className="link-item-line">
                    {line.text}
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h2 className="link-heading">{t("backlinks.linksTo", { count: outgoing.length })}</h2>
      {outgoing.length === 0 ? (
        <p className="muted">{t("backlinks.noLinks")}</p>
      ) : (
        <ul className="link-list">
          {outgoing.map((link) => (
            <li key={`${link.target}:${link.embed}`}>
              {link.path ? (
                <button type="button" className="link-item" onClick={() => onOpen(link.path!)}>
                  <span className="link-item-title">{basename(link.path)}</span>
                  {link.embed && (
                    <span className="muted link-item-detail">{t("backlinks.embed")}</span>
                  )}
                </button>
              ) : (
                <span className="link-item link-item-missing">
                  <span className="link-item-title">{link.target}</span>
                  <span className="muted link-item-detail">{t("backlinks.unresolved")}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
