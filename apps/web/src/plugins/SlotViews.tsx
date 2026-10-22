import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { resolveLocalized } from "@palimvo/plugin-sdk";
import { registerCommands } from "../commands/registry.ts";
import { Button, Icon, isIconName } from "../ui/index.ts";
import { PluginFrame } from "./PluginFrame.tsx";
import { usePluginRuntime } from "./PluginsProvider.tsx";
import { useSlotItems, type SlotItem } from "./slots.ts";

/** A plugin entry as a button of the top bar: its icon when the app has one, else its title. */
export function SlotToolbar({ path }: { path: string | null }) {
  const items = useSlotItems("toolbar", { path });
  if (items.length === 0) return null;
  return (
    <div className="slot-toolbar" role="group">
      {items.map((item) =>
        isIconName(item.icon) ? (
          <Button
            key={item.key}
            variant="ghost"
            icon={item.icon}
            aria-label={item.title}
            title={item.title}
            onClick={() => void item.run()}
          />
        ) : (
          <button
            key={item.key}
            type="button"
            className="btn btn-ghost slot-toolbar-text"
            title={item.title}
            onClick={() => void item.run()}
          >
            {item.title}
          </button>
        ),
      )}
    </div>
  );
}

/** The thin bar under the main area; absent unless a plugin has a status-bar entry to show. */
export function SlotStatusBar({ path }: { path: string | null }) {
  const { t } = useTranslation();
  const items = useSlotItems("status-bar", { path });
  if (items.length === 0) return null;
  return (
    <footer className="statusbar" aria-label={t("plugins.slot.statusBar")}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="statusbar-item"
          onClick={() => void item.run()}
        >
          {isIconName(item.icon) && <Icon name={item.icon} />}
          {item.title}
        </button>
      ))}
    </footer>
  );
}

/** Registers the plugins' command-palette entries as commands. Renders nothing. */
export function PluginCommands({ path }: { path: string | null }) {
  const items = useSlotItems("command-palette", { path });
  useEffect(
    () =>
      registerCommands(
        items.map((item: SlotItem) => ({
          id: `plugin.${item.pluginId}.${item.id}`,
          title: item.title,
          ...(isIconName(item.icon) ? { icon: item.icon } : {}),
          run: () => void item.run(),
        })),
      ),
    [items],
  );
  return null;
}

/** One section per `settings` entry: the host draws the heading, the plugin draws inside it. */
export function PluginSettingsSections() {
  const { i18n } = useTranslation();
  const runtime = usePluginRuntime();
  const entries = runtime?.registry.slotEntries("settings") ?? [];
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((entry) => {
        const plugin = runtime?.host.get(entry.pluginId)?.plugin.manifest;
        return (
          <section
            key={`${entry.pluginId}/${entry.id}`}
            className="plugin-settings"
            aria-labelledby={`plugin-settings-${entry.pluginId}-${entry.id}`}
          >
            <h3 id={`plugin-settings-${entry.pluginId}-${entry.id}`}>
              {resolveLocalized(entry.title, i18n.language)}
            </h3>
            {plugin && (
              <PluginFrame
                pluginId={entry.pluginId}
                mode="slot"
                target={`settings/${entry.id}`}
                autoHeight
              />
            )}
          </section>
        );
      })}
    </>
  );
}
