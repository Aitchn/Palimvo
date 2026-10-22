import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { resolveLocalized } from "@palimvo/plugin-sdk";
import { PluginFrame } from "./PluginFrame.tsx";
import { usePluginRuntime } from "./PluginsProvider.tsx";

export interface PluginViewRef {
  plugin: string;
  view: string;
}

/** `/v/<vault>?plugin=<id>&view=<id>`: the address of a plugin's page. */
export function pluginViewHref(vaultHref: string, ref: PluginViewRef): string {
  const query = new URLSearchParams({ plugin: ref.plugin, view: ref.view });
  return `${vaultHref}?${query}`;
}

/** Sidebar list of the pages plugins add; renders nothing when no plugin has one. */
export function PluginViewLinks({
  active,
  onOpen,
}: {
  active: PluginViewRef | null;
  onOpen: (ref: PluginViewRef) => void;
}) {
  const { t, i18n } = useTranslation();
  const runtime = usePluginRuntime();
  const views = runtime?.registry.views ?? [];
  if (views.length === 0) return null;
  return (
    <nav className="plugin-views" aria-label={t("plugins.views.title")}>
      <h3 className="plugin-views-title">{t("plugins.views.title")}</h3>
      {views.map((view) => {
        const current = active?.plugin === view.pluginId && active.view === view.id;
        return (
          <button
            key={`${view.pluginId}/${view.id}`}
            type="button"
            className="plugin-view-link"
            aria-current={current ? "page" : undefined}
            onClick={() => onOpen({ plugin: view.pluginId, view: view.id })}
          >
            {resolveLocalized(view.name, i18n.language)}
          </button>
        );
      })}
    </nav>
  );
}

/** The main area when a plugin's page is open. */
export function PluginView({ plugin, view }: PluginViewRef) {
  const { t } = useTranslation();
  const runtime = usePluginRuntime();
  const known = runtime?.registry.view(plugin, view);
  if (!known) {
    return (
      <div className="state" role={runtime?.loaded ? "alert" : "status"}>
        <p className="muted">
          {runtime?.loaded ? t("plugins.views.missing") : t("plugins.loading")}
        </p>
      </div>
    );
  }
  return (
    <div className="plugin-view">
      <PluginFrame pluginId={plugin} mode="view" target={view} />
    </div>
  );
}

/**
 * Tells plugins which note is open and which files appeared or went away. The tree carries no
 * author or change time, so `author` is empty and edits of an existing file are not reported;
 * a live change feed adds those later.
 */
export function PluginEvents({
  ready,
  files,
  activePath,
}: {
  ready: boolean;
  files: readonly string[];
  activePath: string | null;
}) {
  const runtime = usePluginRuntime();
  const host = runtime?.host;
  const previous = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (!host || !ready) return;
    const now = new Set(files);
    const before = previous.current;
    previous.current = now;
    if (!before) return;
    for (const path of now) {
      if (!before.has(path)) host.emit("file:changed", { path, kind: "created", author: "" });
    }
    for (const path of before) {
      if (!now.has(path)) host.emit("file:changed", { path, kind: "deleted", author: "" });
    }
  }, [host, ready, files]);

  useEffect(() => {
    if (host && activePath) host.emit("file:opened", { path: activePath });
  }, [host, activePath]);
  return null;
}
