import {
  resolveLocalized,
  type HomeWidgetSize,
  type LocalizedText,
  type SlotName,
} from "@palimvo/plugin-sdk";
import type { HostedPlugin } from "./host.ts";

export interface ViewEntry {
  pluginId: string;
  id: string;
  name: LocalizedText;
  icon?: string;
}

export interface ViewerEntry {
  pluginId: string;
  id: string;
  name: LocalizedText;
  extensions: readonly string[];
}

export interface HomeWidgetEntry {
  pluginId: string;
  id: string;
  name: LocalizedText;
  size: HomeWidgetSize;
}

export interface SlotEntry {
  pluginId: string;
  slot: SlotName;
  id: string;
  title: LocalizedText;
  icon?: string;
}

export interface ThemeEntry {
  pluginId: string;
  name: LocalizedText;
  /** The plugin's stylesheet as delivered; run it through `sanitizeThemeCss` before use. */
  css: string;
}

export interface AppEntry {
  pluginId: string;
  name: LocalizedText;
  icon?: string;
}

/**
 * What the running plugins add, as plain lists the interface can draw from. A code block
 * language, component type or base view that two plugins both claim has no renderer: a quiet
 * last-writer-wins would let one plugin silently take over another's notes.
 */
export class ContributionRegistry {
  readonly views: readonly ViewEntry[];
  readonly viewers: readonly ViewerEntry[];
  readonly homeWidgets: readonly HomeWidgetEntry[];
  readonly slots: readonly SlotEntry[];
  /** language → plugin id */
  readonly codeBlocks: ReadonlyMap<string, string>;
  /** type → plugin id */
  readonly components: ReadonlyMap<string, string>;
  /** type → plugin id */
  readonly baseViews: ReadonlyMap<string, string>;
  readonly app: ReadonlyMap<string, { name: LocalizedText; icon?: string }>;
  readonly apps: readonly AppEntry[];
  readonly themes: readonly ThemeEntry[];
  /** Human-readable clashes, for the plugin settings. */
  readonly conflicts: readonly string[];

  constructor(plugins: Iterable<HostedPlugin>) {
    const views: ViewEntry[] = [];
    const viewers: ViewerEntry[] = [];
    const homeWidgets: HomeWidgetEntry[] = [];
    const slots: SlotEntry[] = [];
    const app = new Map<string, { name: LocalizedText; icon?: string }>();
    const themes: ThemeEntry[] = [];
    const owners = {
      codeBlocks: new Map<string, string[]>(),
      components: new Map<string, string[]>(),
      baseViews: new Map<string, string[]>(),
    };
    const claim = (map: Map<string, string[]>, key: string, id: string) =>
      map.set(key, [...(map.get(key) ?? []), id]);

    const sorted = [...plugins]
      .filter((entry) => entry.session.active)
      .sort((a, b) => a.plugin.manifest.id.localeCompare(b.plugin.manifest.id));
    for (const { plugin } of sorted) {
      const { id } = plugin.manifest;
      const c = plugin.manifest.contributes;
      for (const v of c.views)
        views.push({ pluginId: id, id: v.id, name: v.name, ...(v.icon ? { icon: v.icon } : {}) });
      for (const v of c.viewers)
        viewers.push({ pluginId: id, id: v.id, name: v.name, extensions: v.extensions });
      for (const w of c.homeWidgets)
        homeWidgets.push({ pluginId: id, id: w.id, name: w.name, size: w.size ?? "medium" });
      for (const s of c.slots)
        slots.push({
          pluginId: id,
          slot: s.slot,
          id: s.id,
          title: s.title,
          ...(s.icon ? { icon: s.icon } : {}),
        });
      for (const b of c.codeBlocks) claim(owners.codeBlocks, b.language, id);
      for (const x of c.components) claim(owners.components, x.type, id);
      for (const b of c.baseViews) claim(owners.baseViews, b.type, id);
      if (c.app) app.set(id, { name: c.app.name, ...(c.app.icon ? { icon: c.app.icon } : {}) });
      if (c.theme && plugin.themeCss !== undefined)
        themes.push({ pluginId: id, name: c.theme.name, css: plugin.themeCss });
    }

    const conflicts: string[] = [];
    const settle = (map: Map<string, string[]>, what: string) => {
      const out = new Map<string, string>();
      for (const [key, ids] of map) {
        if (ids.length === 1) out.set(key, ids[0] as string);
        else conflicts.push(`${what} "${key}": ${ids.join(", ")}`);
      }
      return out;
    };
    this.codeBlocks = settle(owners.codeBlocks, "code block");
    this.components = settle(owners.components, "component");
    this.baseViews = settle(owners.baseViews, "base view");
    this.views = views;
    this.viewers = viewers;
    this.homeWidgets = homeWidgets;
    this.slots = slots;
    this.app = app;
    this.apps = [...app].map(([pluginId, a]) => ({ pluginId, ...a }));
    this.themes = themes;
    this.conflicts = conflicts;
  }

  /** Plugin viewers offered for a file, by its extension; several plugins may each offer one. */
  viewersFor(path: string): ViewerEntry[] {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return [];
    const extension = name.slice(dot + 1).toLowerCase();
    return this.viewers.filter((viewer) => viewer.extensions.includes(extension));
  }

  /** Every extension some plugin viewer handles. */
  get viewerExtensions(): ReadonlySet<string> {
    return new Set(this.viewers.flatMap((viewer) => viewer.extensions));
  }

  homeWidget(pluginId: string, id: string): HomeWidgetEntry | undefined {
    return this.homeWidgets.find((w) => w.pluginId === pluginId && w.id === id);
  }

  view(pluginId: string, id: string): ViewEntry | undefined {
    return this.views.find((v) => v.pluginId === pluginId && v.id === id);
  }

  /** Slot entries of one slot, in plugin order. */
  slotEntries(slot: SlotName): SlotEntry[] {
    return this.slots.filter((entry) => entry.slot === slot);
  }
}

export const label = (text: LocalizedText, locale: string): string =>
  resolveLocalized(text, locale);
