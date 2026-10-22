import { useCallback, useState } from "react";
import { remapPath } from "../files/model.ts";
import { readList, writeList } from "./storage.ts";

const key = (vault: string) => `palimvo.expanded.${vault}`;

/** Which folders of the tree are open (mount it with `key={vault}`). Remembered per vault in this browser. */
export function useExpanded(vault: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readList(key(vault))));

  const commit = useCallback(
    (next: Set<string>) => {
      writeList(key(vault), [...next]);
      return next;
    },
    [vault],
  );

  const toggle = useCallback(
    (folder: string) =>
      setExpanded((old) => {
        const next = new Set(old);
        if (!next.delete(folder)) next.add(folder);
        return commit(next);
      }),
    [commit],
  );

  /** Opens these folders (and leaves the others as they are). */
  const reveal = useCallback(
    (folders: string[]) =>
      setExpanded((old) => {
        if (folders.every((f) => old.has(f))) return old;
        return commit(new Set([...old, ...folders]));
      }),
    [commit],
  );

  /** A folder was renamed or moved: keep it and what is inside it open under the new name. */
  const remap = useCallback(
    (from: string, to: string | null) =>
      setExpanded((old) => {
        const next = new Set<string>();
        for (const p of old) {
          const moved = remapPath(p, from, to);
          if (moved !== null) next.add(moved);
        }
        return commit(next);
      }),
    [commit],
  );

  return { expanded, toggle, reveal, remap };
}
