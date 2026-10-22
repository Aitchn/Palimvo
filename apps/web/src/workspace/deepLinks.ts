import { encodePath } from "../api/client.ts";

/** `/v/<vault>`: the vault with nothing open. */
export function vaultHref(vault: string): string {
  return `/v/${encodeURIComponent(vault)}`;
}

/** `/v/<vault>/<path>`: the address of a file. Anyone with access can open it, and reloading returns to it. */
export function fileHref(vault: string, path: string): string {
  return `${vaultHref(vault)}/${encodePath(path)}`;
}

/**
 * The vault path in the address bar (the router's `*` match, already percent-decoded), without
 * the slashes people add by hand. `""` when no file is named.
 */
export function pathFromLocation(splat: string | undefined): string {
  return (splat ?? "")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}
