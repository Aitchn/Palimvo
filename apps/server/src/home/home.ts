import {
  AppError,
  HOME_FILE,
  MAX_HOME_PINNED,
  MAX_HOME_WIDGETS,
  VAULT_META_DIR,
  defaultHomeConfig,
  fileKind,
  migrateHomeConfig,
  normalizeVaultPath,
  type ActivityFilter,
  type Author,
  type HomeConfig,
} from "@palimvo/core";
import { z } from "zod";
import { isHiddenPath } from "../auth/publicPolicy.ts";
import type { ChangeNote, VaultHistory } from "../history/history.ts";
import { contentVersion } from "../vault/fsutil.ts";
import { KeyedMutex } from "../vault/mutex.ts";
import type { VaultService } from "../vault/service.ts";
import { ACTIVITY_WINDOW, summarizeActivity, type Activity } from "./activity.ts";

const widgetId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);
const vaultPath = z.string().min(1).max(500);

const widgetSchema = z.discriminatedUnion("type", [
  z.object({
    id: widgetId,
    type: z.literal("activity"),
    limit: z.number().int().min(5).max(100).optional(),
  }),
  z.object({ id: widgetId, type: z.literal("proposals") }),
  z.object({ id: widgetId, type: z.literal("pinned") }),
  z.object({
    id: widgetId,
    type: z.literal("base"),
    path: vaultPath,
    view: z.string().max(100).optional(),
  }),
  z.object({
    id: widgetId,
    type: z.literal("plugin"),
    plugin: slug,
    view: z.string().min(1).max(100),
  }),
]);

export const homeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    widgets: z.array(widgetSchema).max(MAX_HOME_WIDGETS),
    pinned: z.array(vaultPath).max(MAX_HOME_PINNED),
    publicNote: vaultPath.nullable(),
  })
  .superRefine((config, ctx) => {
    if (new Set(config.widgets.map((w) => w.id)).size !== config.widgets.length) {
      ctx.addIssue({ code: "custom", message: "Widget ids must be unique", path: ["widgets"] });
    }
  });

export const homePutSchema = z.object({
  config: homeConfigSchema,
  /** The version the editor started from (`null`: the vault had no `home.json`). */
  baseVersion: z.string().nullable(),
});

export interface HomeState {
  config: HomeConfig;
  /** Identifies the stored file; `null` while the vault still shows the default page. */
  version: string | null;
}

const badPath = (path: string): AppError => new AppError("invalid_path", undefined, { path });

function cleanPath(path: string): string {
  let normalized: string;
  try {
    normalized = normalizeVaultPath(path);
  } catch {
    throw badPath(path);
  }
  if (isHiddenPath(normalized)) throw badPath(path);
  return normalized;
}

/** Checks paths and removes repeats; the result is what gets stored. */
function tidy(config: z.output<typeof homeConfigSchema>): HomeConfig {
  const widgets = config.widgets.map((w) => {
    if (w.type !== "base") return w;
    const path = cleanPath(w.path);
    if (fileKind(path) !== "base") {
      throw new AppError("invalid_request", undefined, {
        field: "widgets",
        path,
        reason: "not a .base file",
      });
    }
    return { ...w, path };
  });
  return {
    schemaVersion: config.schemaVersion,
    widgets,
    pinned: [...new Set(config.pinned.map(cleanPath))],
    publicNote: config.publicNote === null ? null : cleanPath(config.publicNote),
  };
}

type Storage = Pick<VaultService, "readMeta" | "writeMeta">;

/** Each vault's home page settings (`.palimvo/home.json`) and its activity wall. */
export class HomeService {
  private readonly lock = new KeyedMutex();

  constructor(
    private readonly vaults: Storage,
    private readonly history: Pick<VaultHistory, "record" | "list" | "commit">,
  ) {}

  async get(vault: string): Promise<HomeState> {
    const raw = await this.vaults.readMeta(vault, HOME_FILE);
    if (raw === null) return { config: defaultHomeConfig(), version: null };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new AppError("schema_invalid", undefined, {
        file: `${VAULT_META_DIR}/${HOME_FILE}`,
        reason: "not JSON",
      });
    }
    const config = migrateHomeConfig(value).data;
    // A hand-edited file must not break the page: one that no longer fits the schema shows the default.
    const parsed = homeConfigSchema.safeParse(config);
    return {
      config: parsed.success ? parsed.data : defaultHomeConfig(),
      version: contentVersion(raw),
    };
  }

  /** Stores new settings; refuses (`version_conflict`) when someone saved since `baseVersion`. */
  put(
    vault: string,
    input: z.output<typeof homePutSchema>,
    author: Author,
    note: ChangeNote = {},
  ): Promise<HomeState> {
    const config = tidy(input.config);
    return this.lock.run(vault, async () => {
      const current = await this.vaults.readMeta(vault, HOME_FILE);
      const version = current === null ? null : contentVersion(current);
      if (version !== input.baseVersion) throw new AppError("version_conflict");
      const text = `${JSON.stringify(config, null, 2)}\n`;
      await this.vaults.writeMeta(vault, HOME_FILE, text, () =>
        this.history.record(vault, [`${VAULT_META_DIR}/${HOME_FILE}`], author, {
          ...note,
          summary: "Update home page",
        }),
      );
      return { config, version: contentVersion(text) };
    });
  }

  async activity(vault: string, filter: ActivityFilter, limit: number): Promise<Activity> {
    // Changes still waiting for their commit belong on a page people look at to see what is new.
    await this.history.commit(vault).catch(() => undefined);
    return summarizeActivity(
      await this.history.list(vault, { limit: ACTIVITY_WINDOW }),
      filter,
      limit,
    );
  }
}
