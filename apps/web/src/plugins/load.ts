import { validateManifest, type PluginManifest } from "@palimvo/plugin-sdk";
import { getRuntimeBundle, listRuntimePlugins } from "../api/plugins.ts";
import type { LoadedPlugin } from "./frame.ts";

export interface LoadFailure {
  id: string;
  reason: string;
}

export interface LoadResult {
  plugins: LoadedPlugin[];
  failures: LoadFailure[];
}

function parseStrings(text: string | undefined): Record<string, string> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Turns what the server sent for one plugin into something runnable, or says why not. The
 * server only sends approved plugins; the browser still refuses a bundle whose hash is not the
 * one that was listed, or whose manifest is not what the list said.
 */
export function assemble(
  info: { id: string; version: string; hash: string; manifest: unknown },
  bundle: { id: string; hash: string; files: Record<string, string> },
  palimvoVersion?: string,
): LoadedPlugin {
  const checked = validateManifest(info.manifest, palimvoVersion ? { palimvoVersion } : {});
  if (!checked.ok) throw new Error(`manifest: ${checked.issues[0]?.message ?? "invalid"}`);
  const manifest: PluginManifest = checked.manifest;
  if (manifest.id !== info.id || manifest.version !== info.version)
    throw new Error("the manifest does not match the listing");
  if (bundle.id !== info.id || bundle.hash !== info.hash)
    throw new Error("the plugin changed while it was loading");
  const code = bundle.files[manifest.main];
  if (typeof code !== "string") throw new Error(`${manifest.main} is missing`);
  const locales: Record<string, Record<string, string>> = {};
  for (const [locale, path] of Object.entries(manifest.locales ?? {})) {
    locales[locale] = parseStrings(bundle.files[path]);
  }
  const css = manifest.contributes.theme ? bundle.files[manifest.contributes.theme.css] : undefined;
  return {
    manifest,
    hash: info.hash,
    code,
    locales,
    ...(css !== undefined ? { themeCss: css } : {}),
  };
}

/**
 * Fetches the plugins that may run in `vault`. Bundles of plugins already loaded at the same
 * hash are not fetched again (`known`).
 */
export async function loadPlugins(
  vault: string,
  known: ReadonlyMap<string, LoadedPlugin>,
  signal?: AbortSignal,
): Promise<LoadResult> {
  const listed = await listRuntimePlugins(vault, { signal });
  const failures: LoadFailure[] = [];
  const plugins = (
    await Promise.all(
      listed.map(async (info): Promise<LoadedPlugin | null> => {
        const have = known.get(info.id);
        if (have && have.hash === info.hash) return have;
        try {
          const bundle = await getRuntimeBundle(vault, info.id, { signal });
          return assemble(info, bundle);
        } catch (error) {
          if (signal?.aborted) throw error;
          failures.push({
            id: info.id,
            reason: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    )
  ).filter((plugin): plugin is LoadedPlugin => plugin !== null);
  return { plugins, failures };
}
