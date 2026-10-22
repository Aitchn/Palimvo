import { useSyncExternalStore } from "react";

/** What the person picked; "system" follows the device's light/dark setting. */
export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "palimvo.theme";
/** Key written by the previous product. Read once, then moved to {@link THEME_KEY}. */
const LEGACY_THEME_KEY = "aitchn.theme";

const listeners = new Set<() => void>();
const media =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null;

function isPreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (isPreference(value)) return value;
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (isPreference(legacy)) {
      localStorage.setItem(THEME_KEY, legacy);
      localStorage.removeItem(LEGACY_THEME_KEY);
      return legacy;
    }
  } catch {
    /* storage blocked: follow the device */
  }
  return "system";
}

let preference: ThemePreference = "system";
let current: Theme = "dark";

function resolve(pref: ThemePreference): Theme {
  if (pref !== "system") return pref;
  return media?.matches ? "light" : "dark";
}

function apply() {
  const next = resolve(preference);
  const root = document.documentElement;
  root.dataset.theme = next;
  root.style.colorScheme = next;
  current = next;
  listeners.forEach((fn) => fn());
}

/** Applies the saved preference and follows the device while it is "system". Call once at start-up. */
export function initTheme(): void {
  preference = readPreference();
  apply();
}

media?.addEventListener?.("change", () => {
  if (preference === "system") apply();
});

/** The theme in use right now (after resolving "system"). */
export function currentTheme(): Theme {
  return current;
}

export function themePreference(): ThemePreference {
  return preference;
}

/** Cross-fades the whole page when the browser supports view transitions and motion is welcome. */
export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* not remembered, still applied */
  }
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const doc = document as Document & { startViewTransition?: (fn: () => void) => unknown };
  if (doc.startViewTransition && !reduce && resolve(next) !== current)
    doc.startViewTransition(apply);
  else apply();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useTheme(): {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
} {
  const theme = useSyncExternalStore(subscribe, currentTheme, currentTheme);
  const pref = useSyncExternalStore(subscribe, themePreference, themePreference);
  return { theme, preference: pref, setPreference: setThemePreference };
}
