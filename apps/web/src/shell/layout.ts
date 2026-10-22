import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** At or below this width the sidebar and the details panel become drawers. */
export const MOBILE_QUERY = "(max-width: 900px)";
const KEY = "palimvo.layout";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia?.(query);
      media?.addEventListener("change", onChange);
      return () => media?.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("online", onChange);
      window.addEventListener("offline", onChange);
      return () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("offline", onChange);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

interface Panels {
  sidebar: boolean;
  inspector: boolean;
}

export const DEFAULT_PANELS: Panels = { sidebar: true, inspector: false };

export function readPanels(): Panels {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { sidebar, inspector } = parsed as Record<string, unknown>;
      return {
        sidebar: typeof sidebar === "boolean" ? sidebar : DEFAULT_PANELS.sidebar,
        inspector: typeof inspector === "boolean" ? inspector : DEFAULT_PANELS.inspector,
      };
    }
  } catch {
    /* storage blocked or not JSON: use the defaults */
  }
  return DEFAULT_PANELS;
}

export type Drawer = "sidebar" | "inspector" | null;

export interface Layout {
  isMobile: boolean;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  closeDrawer: () => void;
}

/**
 * Which side panels are showing. Wide screens remember the choice between visits; on a phone the
 * panels are drawers that start closed and never stay open behind the page.
 */
export function useLayout(): Layout {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [panels, setPanels] = useState<Panels>(readPanels);
  const [drawer, setDrawer] = useState<Drawer>(null);

  useEffect(() => {
    if (!isMobile) setDrawer(null);
  }, [isMobile]);

  const update = useCallback((next: Panels) => {
    setPanels(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  }, []);

  const closeDrawer = useCallback(() => setDrawer(null), []);

  return {
    isMobile,
    sidebarOpen: isMobile ? drawer === "sidebar" : panels.sidebar,
    inspectorOpen: isMobile ? drawer === "inspector" : panels.inspector,
    toggleSidebar: () =>
      isMobile
        ? setDrawer((d) => (d === "sidebar" ? null : "sidebar"))
        : update({ ...panels, sidebar: !panels.sidebar }),
    toggleInspector: () =>
      isMobile
        ? setDrawer((d) => (d === "inspector" ? null : "inspector"))
        : update({ ...panels, inspector: !panels.inspector }),
    closeDrawer,
  };
}
