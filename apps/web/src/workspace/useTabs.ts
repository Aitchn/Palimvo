import { useCallback, useRef, useState } from "react";
import { pathKey } from "@palimvo/core";
import { remapPath } from "../files/model.ts";
import { readList, writeList } from "./storage.ts";

const key = (vault: string) => `palimvo.tabs.${vault}`;

/** The files open as tabs in one vault (mount it with `key={vault}`). The list is remembered per vault in this browser. */
export function useTabs(vault: string) {
  const [tabs, setTabs] = useState<string[]>(() => readList(key(vault)));
  const current = useRef(tabs);
  current.current = tabs;

  const update = useCallback(
    (next: string[]) => {
      current.current = next;
      setTabs(next);
      writeList(key(vault), next);
    },
    [vault],
  );

  /** Adds the tab if it is not there yet. */
  const open = useCallback(
    (path: string) => {
      if (!current.current.some((p) => pathKey(p) === pathKey(path))) {
        update([...current.current, path]);
      }
    },
    [update],
  );

  /** Closes a tab; returns the file to show instead (the neighbour on the right, else the left), or `null`. */
  const close = useCallback(
    (path: string): string | null => {
      const at = current.current.findIndex((p) => pathKey(p) === pathKey(path));
      if (at < 0) return null;
      const next = current.current.filter((_, i) => i !== at);
      update(next);
      return next[at] ?? next[at - 1] ?? null;
    },
    [update],
  );

  /** A file or folder was renamed/moved (`to`) or deleted (`null`). */
  const remap = useCallback(
    (from: string, to: string | null) => {
      const next = current.current
        .map((p) => remapPath(p, from, to))
        .filter((p): p is string => p !== null);
      if (next.some((p, i) => p !== current.current[i]) || next.length !== current.current.length) {
        update(next);
      }
    },
    [update],
  );

  return { tabs, open, close, remap };
}
