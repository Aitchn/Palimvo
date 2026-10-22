import { encodePath, request, requestText, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}/plugins`;

/** A plugin that may run now in this vault: enabled, approved at exactly this hash, dependencies met. */
export interface RuntimePluginInfo {
  id: string;
  version: string;
  /** The hash a person approved. */
  hash: string;
  /** The package's `manifest.json`; the browser validates it again. */
  manifest: unknown;
}

interface InstalledPluginDto {
  id: string;
  version: string;
  sha256: string;
  state: "running" | "disabled" | "needs_approval" | "blocked";
  manifest: unknown;
}

/** The installed plugins that are running, i.e. approved at their current hash. */
export async function listRuntimePlugins(
  vault: string,
  options: Signal = {},
): Promise<RuntimePluginInfo[]> {
  const { plugins } = await request<{ plugins: InstalledPluginDto[] }>(base(vault), options);
  return plugins
    .filter((plugin) => plugin.state === "running")
    .map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      hash: plugin.sha256,
      manifest: plugin.manifest,
    }));
}

/** One text file of a running plugin; the server re-hashes the package before it serves it. */
export function getPluginFile(
  vault: string,
  id: string,
  path: string,
  options: Signal = {},
): Promise<string> {
  return requestText(`${base(vault)}/${encodeURIComponent(id)}/files/${encodePath(path)}`, options);
}
