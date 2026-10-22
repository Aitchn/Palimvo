import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * The folder with the official plugins: the one given, `plugins/` next to the bundle, or the
 * monorepo's `plugins/` (three levels above both `apps/server/src` and `apps/server/dist`).
 */
export async function findPluginsDir(
  configured: string | undefined,
  here: string,
): Promise<string | undefined> {
  const candidates = [
    ...(configured ? [path.resolve(configured)] : []),
    path.resolve(here, "plugins"),
    path.resolve(here, "../../../plugins"),
  ];
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) return candidate;
  }
  return undefined;
}
