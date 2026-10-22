import type { ActivityFilter, Author, HomeConfig } from "@palimvo/core";
import { request, type RequestOptions } from "./client.ts";
import { ApiError } from "./errors.ts";
import type { CommitInfo } from "./history.ts";

type Signal = Pick<RequestOptions, "signal">;

export interface HomeState {
  config: HomeConfig;
  /** Sent back when saving; `null` while the vault still shows the default page. */
  version: string | null;
}

export interface ActivityAuthor {
  author: Author;
  count: number;
  lastAt: string;
}

export interface Activity {
  filter: ActivityFilter;
  entries: CommitInfo[];
  authors: ActivityAuthor[];
}

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}/home`;

export function getHome(vault: string, options: Signal = {}): Promise<HomeState> {
  return request<HomeState>(base(vault), options);
}

export function putHome(
  vault: string,
  config: HomeConfig,
  baseVersion: string | null,
): Promise<HomeState> {
  return request<HomeState>(base(vault), { method: "PUT", body: { config, baseVersion } });
}

export function getActivity(
  vault: string,
  options: Signal & { filter?: ActivityFilter; limit?: number } = {},
): Promise<Activity> {
  const query = new URLSearchParams();
  if (options.filter) query.set("filter", options.filter);
  if (options.limit) query.set("limit", String(options.limit));
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<Activity>(`${base(vault)}/activity${suffix}`, { signal: options.signal });
}

/** Pins or unpins one note, keeping the rest of the page as it is. Retries once if someone saved meanwhile. */
export async function setPinned(vault: string, path: string, pinned: boolean): Promise<HomeState> {
  for (let attempt = 0; ; attempt++) {
    const { config, version } = await getHome(vault);
    const others = config.pinned.filter((p) => p !== path);
    const next: HomeConfig = {
      ...config,
      pinned: pinned ? [...others, path] : others,
      // Pinning on a page without the pinned block would change nothing the person can see.
      widgets:
        pinned && !config.widgets.some((w) => w.type === "pinned")
          ? [...config.widgets, { id: "pinned", type: "pinned" }]
          : config.widgets,
    };
    try {
      return await putHome(vault, next, version);
    } catch (error) {
      if (attempt > 0 || !(error instanceof ApiError) || error.code !== "version_conflict")
        throw error;
    }
  }
}
