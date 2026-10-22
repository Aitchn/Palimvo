import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchHit } from "@palimvo/core";
import { searchVault } from "../api/search.ts";

/** How long typing must pause before the server is asked. */
export const SEARCH_DELAY_MS = 250;
const PAGE = 30;

export type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; hits: SearchHit[]; total: number; loadingMore: boolean };

/** Searches the vault for `query` shortly after typing stops; `more()` appends the next page. */
export function useSearch(vault: string, query: string): SearchState & { more: () => void } {
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const latest = useRef(state);
  latest.current = state;
  const controller = useRef<AbortController | undefined>(undefined);
  const trimmed = query.trim();

  useEffect(() => {
    controller.current?.abort();
    if (trimmed === "") {
      setState({ status: "idle" });
      return;
    }
    const mine = (controller.current = new AbortController());
    setState((s) => (s.status === "ready" ? { ...s, loadingMore: false } : { status: "loading" }));
    const timer = setTimeout(() => {
      searchVault(vault, trimmed, { limit: PAGE, signal: mine.signal }).then(
        (page) => {
          if (!mine.signal.aborted)
            setState({ status: "ready", hits: page.hits, total: page.total, loadingMore: false });
        },
        (error: unknown) => {
          if (!mine.signal.aborted) setState({ status: "error", error });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      mine.abort();
    };
  }, [vault, trimmed]);

  const more = useCallback(() => {
    const current = latest.current;
    if (current.status !== "ready" || current.loadingMore || current.hits.length >= current.total)
      return;
    const mine = (controller.current = new AbortController());
    setState({ ...current, loadingMore: true });
    searchVault(vault, trimmed, {
      offset: current.hits.length,
      limit: PAGE,
      signal: mine.signal,
    }).then(
      (page) => {
        if (mine.signal.aborted) return;
        setState({
          status: "ready",
          hits: [...current.hits, ...page.hits],
          total: page.total,
          loadingMore: false,
        });
      },
      (error: unknown) => {
        if (!mine.signal.aborted) setState({ status: "error", error });
      },
    );
  }, [vault, trimmed]);

  return { ...state, more };
}
