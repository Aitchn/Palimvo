import { createMigrator } from "./migrations.ts";

/** Where a vault keeps its home page settings, inside the vault's `.palimvo/` folder. */
export const HOME_FILE = "home.json";

export const HOME_SCHEMA_VERSION = 1;
export const MAX_HOME_WIDGETS = 12;
export const MAX_HOME_PINNED = 50;

/** One block of the vault home page. `id` is unique within the page. */
export type HomeWidget =
  /** Recent changes, grouped by who made them; people and AIs can be filtered. */
  | { id: string; type: "activity"; limit?: number }
  /** Edit proposals waiting for a decision. */
  | { id: string; type: "proposals" }
  /** The pinned notes. */
  | { id: string; type: "pinned" }
  /** A link card to a database (`.base`) file, optionally to one of its views. */
  | { id: string; type: "base"; path: string; view?: string }
  /** A view contributed by an enabled plugin (rendered once the plugin host exists). */
  | { id: string; type: "plugin"; plugin: string; view: string };

export type HomeWidgetType = HomeWidget["type"];

export interface HomeConfig extends Record<string, unknown> {
  schemaVersion: number;
  /** Top to bottom on a phone; left to right, then down, on a wide screen. */
  widgets: HomeWidget[];
  /** Vault paths of pinned notes, in display order. */
  pinned: string[];
  /** The note guests see first when the vault is public (it must be public itself). */
  publicNote: string | null;
}

/** Upgrades older `home.json` content; future versions add steps here. */
export const migrateHomeConfig = createMigrator<HomeConfig>({
  current: HOME_SCHEMA_VERSION,
  migrations: [],
});

/** What a vault shows until someone customizes it: pending proposals, then the activity wall, then pins. */
export function defaultHomeConfig(): HomeConfig {
  return {
    schemaVersion: HOME_SCHEMA_VERSION,
    widgets: [
      { id: "proposals", type: "proposals" },
      { id: "activity", type: "activity" },
      { id: "pinned", type: "pinned" },
    ],
    pinned: [],
    publicNote: null,
  };
}

export type ActivityFilter = "all" | "human" | "ai";

export const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "human", "ai"];
