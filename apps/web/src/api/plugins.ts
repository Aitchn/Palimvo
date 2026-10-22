import { request, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}/plugin-runtime`;

/** A plugin that may run now in this vault: enabled, approved at exactly this hash, dependencies met. */
export interface RuntimePluginInfo {
  id: string;
  version: string;
  /** The hash a person approved. */
  hash: string;
  /** The package's `manifest.json`; the browser validates it again. */
  manifest: unknown;
}

/** The files of one approved plugin that the browser needs to run it (text only). */
export interface RuntimeBundle {
  id: string;
  hash: string;
  /** Package path → text: `manifest.main`, the `locales` files and a theme stylesheet. */
  files: Record<string, string>;
}

export async function listRuntimePlugins(
  vault: string,
  options: Signal = {},
): Promise<RuntimePluginInfo[]> {
  return (await request<{ plugins: RuntimePluginInfo[] }>(base(vault), options)).plugins;
}

export function getRuntimeBundle(
  vault: string,
  id: string,
  options: Signal = {},
): Promise<RuntimeBundle> {
  return request<RuntimeBundle>(`${base(vault)}/${encodeURIComponent(id)}`, options);
}
