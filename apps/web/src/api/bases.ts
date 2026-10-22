import type { BaseResult, CellValue } from "@palimvo/core";
import { request, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}/bases`;

/** What to run: a `.base` file (`path`) or the YAML of a ```base block (`source`, inside the note `thisPath`). */
export interface BaseQuery {
  path?: string;
  source?: string;
  thisPath?: string;
  view?: string | number;
  columns?: string[];
}

/** The rows of one view; for a file also the `version` it was read at. */
export type BaseQueryResult = BaseResult & { version?: string };

export function queryBase(
  vault: string,
  query: BaseQuery,
  options: Signal = {},
): Promise<BaseQueryResult> {
  return request<BaseQueryResult>(`${base(vault)}/query`, {
    method: "POST",
    body: query,
    ...options,
  });
}

/** Sets a note property (`null` removes it): what editing a cell does. */
export function setProperty(
  vault: string,
  path: string,
  key: string,
  value: CellValue,
): Promise<{ path: string; version: string; mtime: number }> {
  return request(`${base(vault)}/property`, { method: "POST", body: { path, key, value } });
}
