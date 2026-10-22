import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveLocalized, type SlotName } from "@palimvo/plugin-sdk";
import { useToast } from "../ui/index.ts";
import { usePluginRuntime } from "./PluginsProvider.tsx";
import type { PluginRuntime } from "./PluginsProvider.tsx";
import type { SlotEntry } from "./registry.ts";
import { canRead, type PluginBinding } from "./session.ts";

/** How long a plugin may take to say whether an entry shows. */
export const SLOT_VISIBLE_TIMEOUT_MS = 5_000;
/** How long a picked entry may run before the host stops waiting. */
export const SLOT_RUN_TIMEOUT_MS = 30_000;

/** What the app knows about the moment an entry is shown or used. */
export interface SlotMoment {
  /** The note or file acted on. */
  path?: string | null;
}

/**
 * The context one plugin receives. The path is the app's own knowledge, so a plugin that may not
 * read it must not learn it from the slot: the field is left out.
 */
export function scopeSlotContext(
  binding: PluginBinding,
  moment: SlotMoment,
): Record<string, unknown> {
  return moment.path && canRead(binding, moment.path) ? { path: moment.path } : {};
}

export interface SlotItem {
  key: string;
  pluginId: string;
  id: string;
  /** Localised title from the manifest. */
  title: string;
  icon?: string;
  /** Runs the plugin's handler with the moment it was shown for; failures show as a message. */
  run: () => Promise<void>;
}

const EMPTY: ReadonlySet<string> = new Set();

function withDeadline<T>(start: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return start(controller.signal).finally(() => clearTimeout(timer));
}

function ask(
  runtime: PluginRuntime,
  entry: SlotEntry,
  op: "run" | "visible",
  moment: SlotMoment,
): Promise<unknown> {
  const hosted = runtime.host.get(entry.pluginId);
  if (!hosted?.session.active) return Promise.reject(new Error("The plugin is not running"));
  const context = scopeSlotContext(hosted.session.binding, moment);
  const frame = runtime.host.backgroundOf(entry.pluginId);
  return withDeadline(
    (signal) => frame.invokeSlot(entry.slot, entry.id, op, context, signal),
    op === "visible" ? SLOT_VISIBLE_TIMEOUT_MS : SLOT_RUN_TIMEOUT_MS,
  );
}

/**
 * The entries plugins offer in one slot for `moment`, those their `visible` handler allows. With
 * a null moment nothing is asked (the menu or bar is not showing). An entry whose plugin fails
 * or is silent stays hidden.
 */
export function useSlotItems(slot: SlotName, moment: SlotMoment | null): SlotItem[] {
  const { i18n, t } = useTranslation();
  const toast = useToast();
  const runtime = usePluginRuntime();
  const entries = useMemo(() => runtime?.registry.slotEntries(slot) ?? [], [runtime, slot]);
  const path = moment === null ? null : (moment.path ?? "");
  // Answers belong to the moment and entries they were asked for; others are not used.
  const [answer, setAnswer] = useState<{
    path: string | null;
    entries: readonly SlotEntry[];
    shown: ReadonlySet<string>;
  } | null>(null);
  const shown = answer && answer.path === path && answer.entries === entries ? answer.shown : EMPTY;

  useEffect(() => {
    if (!runtime || path === null || entries.length === 0) {
      setAnswer(null);
      return;
    }
    let current = true;
    const forThis: SlotMoment = path === "" ? {} : { path };
    void Promise.all(
      entries.map(async (entry) => {
        try {
          const answer = await ask(runtime, entry, "visible", forThis);
          return answer === true ? `${entry.pluginId}/${entry.id}` : null;
        } catch {
          return null;
        }
      }),
    ).then((keys) => {
      if (current)
        setAnswer({
          path,
          entries,
          shown: new Set(keys.filter((key): key is string => key !== null)),
        });
    });
    return () => {
      current = false;
    };
  }, [runtime, entries, path]);

  const run = useCallback(
    async (entry: SlotEntry, at: SlotMoment) => {
      if (!runtime) return;
      try {
        await ask(runtime, entry, "run", at);
      } catch (error) {
        const name = resolveLocalized(
          runtime.host.get(entry.pluginId)?.plugin.manifest.name,
          i18n.language,
        );
        toast.push({
          message: t("plugins.slot.failed", {
            name: name || entry.pluginId,
            detail: error instanceof Error ? error.message : String(error),
          }),
          kind: "error",
        });
      }
    },
    [runtime, i18n.language, t, toast],
  );

  return useMemo(
    () =>
      moment === null
        ? []
        : entries
            .filter((entry) => shown.has(`${entry.pluginId}/${entry.id}`))
            .map((entry) => ({
              key: `${entry.pluginId}/${entry.id}`,
              pluginId: entry.pluginId,
              id: entry.id,
              title: resolveLocalized(entry.title, i18n.language),
              ...(entry.icon ? { icon: entry.icon } : {}),
              run: () => run(entry, moment),
            })),
    // `moment` is a fresh object each render; its path is what matters.
    [entries, shown, i18n.language, run, path],
  );
}
