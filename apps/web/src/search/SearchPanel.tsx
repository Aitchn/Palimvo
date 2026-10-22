import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { basename, dirname, fileKind, searchTerms } from "@palimvo/core";
import { describeError } from "../api/errors.ts";
import { Button, Icon, Skeleton, type IconName } from "../ui/index.ts";
import { highlight } from "./highlight.tsx";
import { useSearch } from "./useSearch.ts";

interface Props {
  vault: string;
  query: string;
  onQueryChange: (query: string) => void;
  /** Changes whenever the search box should take focus (the search command ran). */
  focusRequest: number;
  activePath: string | null;
  onOpen: (path: string) => void;
}

const ICONS: Record<string, IconName> = { markdown: "note", canvas: "canvas", base: "base" };

/** Full-text search of the vault in the sidebar: results with the matching lines, highlighted. */
export function SearchPanel({
  vault,
  query,
  onQueryChange,
  focusRequest,
  activePath,
  onOpen,
}: Props) {
  const { t } = useTranslation();
  const search = useSearch(vault, query);
  const input = useRef<HTMLInputElement>(null);
  const terms = searchTerms(query);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  return (
    <div className="search-panel">
      <div className="search-box">
        <input
          ref={input}
          className="input"
          type="search"
          role="searchbox"
          aria-label={t("search.title")}
          placeholder={t("search.placeholder")}
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              event.stopPropagation();
              onQueryChange("");
            }
          }}
        />
        {query !== "" && (
          <Button
            variant="ghost"
            icon="close"
            aria-label={t("search.clear")}
            onClick={() => {
              onQueryChange("");
              input.current?.focus();
            }}
          />
        )}
      </div>
      <div className="search-results" aria-live="polite">
        {search.status === "idle" && <p className="muted search-note">{t("search.hint")}</p>}
        {search.status === "loading" && <Skeleton lines={4} />}
        {search.status === "error" && (
          <p className="search-note" role="alert">
            {describeError(t, search.error)}
          </p>
        )}
        {search.status === "ready" &&
          (search.hits.length === 0 ? (
            <p className="muted search-note">{t("search.empty", { query: query.trim() })}</p>
          ) : (
            <>
              <p className="muted search-note">{t("search.total", { count: search.total })}</p>
              <ul className="search-list" aria-label={t("search.list")}>
                {search.hits.map((hit) => (
                  <li key={hit.path}>
                    <button
                      type="button"
                      className="search-hit"
                      aria-current={hit.path === activePath ? "page" : undefined}
                      onClick={() => onOpen(hit.path)}
                    >
                      <span className="search-hit-title">
                        <Icon name={ICONS[fileKind(hit.path)] ?? "note"} />
                        <span>{highlight(basename(hit.path), terms)}</span>
                      </span>
                      {dirname(hit.path) !== "" && (
                        <span className="muted search-hit-path">{dirname(hit.path)}</span>
                      )}
                      {hit.matches.map((m) => (
                        <span key={m.line} className="search-hit-line">
                          {highlight(m.text, terms)}
                        </span>
                      ))}
                    </button>
                  </li>
                ))}
              </ul>
              {search.hits.length < search.total && (
                <Button className="search-more" loading={search.loadingMore} onClick={search.more}>
                  {t("search.more")}
                </Button>
              )}
            </>
          ))}
      </div>
    </div>
  );
}
