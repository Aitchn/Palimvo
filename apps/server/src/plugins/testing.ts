import type { PluginFile } from "@palimvo/plugin-sdk";

const enc = new TextEncoder();

export const file = (path: string, text: string): PluginFile => ({
  path,
  bytes: enc.encode(text),
});

/** A small valid package: manifest.json plus main.js. `manifest` fields override the defaults. */
export function samplePackage(
  id = "board",
  version = "1.0.0",
  manifest: Record<string, unknown> = {},
  code = "export default () => {};",
): PluginFile[] {
  return [
    file(
      "manifest.json",
      JSON.stringify({
        manifestVersion: 2,
        id,
        version,
        name: { en: `Plugin ${id}` },
        permissions: { read: ["notes"], write: [], network: false },
        contributes: { views: [{ id: "main", name: { en: "Main" } }] },
        ...manifest,
      }),
    ),
    file("main.js", code),
  ];
}

/** The same package as the JSON the HTTP API and MCP tools take. */
export const asRequestFiles = (files: readonly PluginFile[]) =>
  files.map((f) => ({ path: f.path, text: new TextDecoder().decode(f.bytes) }));
