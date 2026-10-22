import type { Backlink, GraphData, OutLink, SearchPage } from "@palimvo/core";
import { request, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}`;

export function searchVault(
  vault: string,
  query: string,
  options: Signal & { offset?: number; limit?: number; folder?: string } = {},
): Promise<SearchPage> {
  const params = new URLSearchParams({ q: query });
  if (options.offset) params.set("offset", String(options.offset));
  if (options.limit) params.set("limit", String(options.limit));
  if (options.folder) params.set("path", options.folder);
  return request<SearchPage>(`${base(vault)}/search?${params}`, { signal: options.signal });
}

export async function backlinksOf(
  vault: string,
  path: string,
  options: Signal = {},
): Promise<Backlink[]> {
  const params = new URLSearchParams({ path });
  return (await request<{ backlinks: Backlink[] }>(`${base(vault)}/backlinks?${params}`, options))
    .backlinks;
}

export async function linksOf(
  vault: string,
  path: string,
  options: Signal = {},
): Promise<OutLink[]> {
  const params = new URLSearchParams({ path });
  return (await request<{ links: OutLink[] }>(`${base(vault)}/links?${params}`, options)).links;
}

/** The link graph of a vault, or the part within `depth` links of one file. */
export function graphOf(
  vault: string,
  options: Signal & { around?: string; depth?: number; tags?: boolean } = {},
): Promise<GraphData> {
  const params = new URLSearchParams();
  if (options.tags) params.set("tags", "1");
  if (options.around) {
    params.set("around", options.around);
    if (options.depth) params.set("depth", String(options.depth));
  }
  const query = params.size > 0 ? `?${params}` : "";
  return request<GraphData>(`${base(vault)}/graph${query}`, { signal: options.signal });
}
