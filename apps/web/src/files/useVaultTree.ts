import { useCallback, useEffect, useRef, useState } from "react";
import type { TreeNode } from "@palimvo/core";
import { fileTreeIfChanged } from "../api/files.ts";

/** How often an open workspace asks the server whether files appeared or went away. */
export const POLL_MS = 5000;

export type TreeState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; tree: TreeNode[] };

/**
 * The vault's file tree, kept fresh: the first load, then a conditional request (`ETag`) every
 * few seconds while the page is visible, and one when the page becomes visible again.
 * `refresh()` fetches now (call it after your own changes). A failed poll keeps the tree on
 * screen; only a failed first load reports an error.
 */
export function useVaultTree(
  vault: string,
): TreeState & { refresh: () => Promise<void>; reload: () => void } {
  const [state, setState] = useState<TreeState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const fetchNow = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let etag: string | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let loaded = false;
    setState({ status: "loading" });

    const run = async (): Promise<void> => {
      controller?.abort();
      const mine = (controller = new AbortController());
      try {
        const result = await fileTreeIfChanged(vault, etag, { signal: mine.signal });
        if (stopped || mine.signal.aborted) return;
        if (result) {
          etag = result.etag;
          loaded = true;
          setState({ status: "ready", tree: result.tree });
        }
      } catch (error) {
        if (stopped || mine.signal.aborted) return;
        if (!loaded) setState({ status: "error", error });
      }
    };

    const schedule = () => {
      timer = setTimeout(async () => {
        if (!document.hidden) await run();
        if (!stopped) schedule();
      }, POLL_MS);
    };
    const onVisible = () => {
      if (!document.hidden && loaded) void run();
    };

    fetchNow.current = run;
    void run().then(() => {
      if (!stopped) schedule();
    });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [vault, attempt]);

  const refresh = useCallback(() => fetchNow.current(), []);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, refresh, reload };
}
