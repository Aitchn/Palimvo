import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { resolveLocalized } from "@palimvo/plugin-sdk";
import { usePluginRuntime } from "./PluginsProvider.tsx";
import { sanitizeThemeCss } from "./themeCss.ts";

/** Which plugin's theme the person picked on this device; empty means the app's own look. */
export const PLUGIN_THEME_KEY = "palimvo.pluginTheme";
const STYLE_ID = "palimvo-plugin-theme";

const listeners = new Set<() => void>();

function read(): string {
  try {
    return localStorage.getItem(PLUGIN_THEME_KEY) ?? "";
  } catch {
    return "";
  }
}

let chosen = read();

export function setPluginTheme(pluginId: string): void {
  chosen = pluginId;
  try {
    if (pluginId) localStorage.setItem(PLUGIN_THEME_KEY, pluginId);
    else localStorage.removeItem(PLUGIN_THEME_KEY);
  } catch {
    /* storage blocked: the choice lasts until the page closes */
  }
  for (const listener of listeners) listener();
}

export function usePluginThemeChoice(): string {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => chosen,
    () => "",
  );
}

/**
 * Puts the chosen plugin theme into the page as one `<style>` element, after the app's own
 * stylesheets so its custom properties win. The text is the sanitised subset only. Renders nothing.
 */
export function PluginThemeStyle() {
  const runtime = usePluginRuntime();
  const choice = usePluginThemeChoice();
  const entry = runtime?.registry.themes.find((theme) => theme.pluginId === choice);
  const css = entry ? sanitizeThemeCss(entry.css).css : "";
  const host = runtime?.host;

  useEffect(() => {
    if (!css) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.append(style);
    // Frames copy the app's variables when they start; running ones are told.
    host?.emit("theme:changed", {
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    });
    return () => {
      style.remove();
      host?.emit("theme:changed", {
        theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      });
    };
  }, [css, host]);
  return null;
}

/** Settings control: pick one of the themes the vault's plugins offer, or none. */
export function PluginThemeChoice() {
  const { t, i18n } = useTranslation();
  const runtime = usePluginRuntime();
  const choice = usePluginThemeChoice();
  const themes = runtime?.registry.themes ?? [];
  if (themes.length === 0) return null;
  return (
    <label className="field">
      <span>{t("plugins.theme.label")}</span>
      <select
        className="input"
        value={themes.some((theme) => theme.pluginId === choice) ? choice : ""}
        onChange={(event) => setPluginTheme(event.target.value)}
      >
        <option value="">{t("plugins.theme.none")}</option>
        {themes.map((theme) => (
          <option key={theme.pluginId} value={theme.pluginId}>
            {resolveLocalized(theme.name, i18n.language)}
          </option>
        ))}
      </select>
    </label>
  );
}
