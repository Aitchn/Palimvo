import { MANIFEST_VERSION, type PluginManifestInput } from "./manifest.ts";
import { validateManifest, type ManifestIssue, type ValidationResult } from "./validate.ts";

/**
 * Converts a version 1 manifest (Obsidian-Aitchn, `.aivault/plugins/<id>/manifest.json`) to
 * version 2, for the legacy importer. Anything that cannot be carried over exactly is listed in
 * `notes`, so the importer can show it and a person can review it before approving.
 */

export type LegacyConversion =
  | { ok: true; manifest: Extract<ValidationResult, { ok: true }>["manifest"]; notes: string[] }
  | { ok: false; issues: ManifestIssue[]; notes: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

export function convertLegacyManifest(v1: unknown): LegacyConversion {
  const notes: string[] = [];
  if (!isObj(v1)) {
    return {
      ok: false,
      issues: [{ path: "", code: "invalid_type", message: "must be an object." }],
      notes,
    };
  }

  // Version 1 allowed "1.0" and "2"; version 2 needs three numbers.
  let version = text(v1.version);
  const short = version && /^\d+(\.\d+)?$/.exec(version);
  if (version && short) {
    const padded = `${version}${".0".repeat(version.split(".").length === 1 ? 2 : 1)}`;
    notes.push(`Version "${version}" became "${padded}".`);
    version = padded;
  }

  const permissions = new Set(asList(v1.permissions));
  const scope = isObj(v1.scope) ? asList(v1.scope.paths) : undefined;
  let globs = ["**"];
  if (scope) {
    globs = [];
    for (const raw of scope) {
      const path = typeof raw === "string" ? raw.replace(/^\/+|\/+$/g, "") : "";
      if (path === "") globs.push("**");
      else if (/[*?[\]{}!\\]/.test(path))
        notes.push(`Scope path "${String(raw)}" has wildcard characters and was dropped.`);
      else globs.push(path);
    }
    if (globs.length === 0)
      notes.push("The old scope allowed no folders, so read and write access is empty.");
  }
  const network = permissions.has("network");
  if (network)
    notes.push(
      'The old "network" permission allowed any host; it became ["*"] and should be narrowed.',
    );

  const views = asList(v1.views).flatMap((raw) => {
    if (!isObj(raw)) return [];
    const id = text(raw.id);
    const name = text(raw.name) ?? id;
    return id && name ? [{ id, name, locations: asList(raw.locations) }] : [];
  });
  const homeWidgets = views
    .filter((v) => v.locations.includes("home"))
    .map((v) => ({ id: v.id, name: v.name }));
  if (homeWidgets.length > 0)
    notes.push("Views that appeared on the home page became home widgets.");

  const requires = asList(v1.requires).flatMap((raw) =>
    isObj(raw) && text(raw.id) ? [[text(raw.id) as string, text(raw.version) ?? "*"] as const] : [],
  );
  if (text(v1.minHostVersion)) {
    notes.push(
      `minHostVersion ${String(v1.minHostVersion)} refers to the old host and was dropped.`,
    );
  }

  const input: Record<string, unknown> = {
    manifestVersion: MANIFEST_VERSION,
    id: v1.id,
    version,
    name: v1.name,
    ...(text(v1.description) ? { description: v1.description } : {}),
    ...(text(v1.author) ? { author: v1.author } : {}),
    permissions: {
      read: permissions.has("read") ? globs : [],
      write: permissions.has("write") ? globs : [],
      network: network ? ["*"] : false,
    },
    dependencies: Object.fromEntries(requires),
    contributes: {
      views: views.map(({ id, name }) => ({ id, name })),
      codeBlocks: asList(v1.codeBlocks).flatMap((l) => (text(l) ? [{ language: l }] : [])),
      components: asList(v1.components).flatMap((raw) =>
        isObj(raw) && text(raw.type)
          ? [
              {
                type: raw.type,
                name: text(raw.name) ?? raw.type,
                ...(text(raw.description) ? { description: raw.description } : {}),
              },
            ]
          : [],
      ),
      fileTypes: asList(v1.fileTypes),
      viewers: asList(v1.fileViews),
      homeWidgets,
      extensionPoints: asList(v1.extensionPoints),
      extensions: asList(v1.extends),
    },
  };
  const result = validateManifest(input as unknown as PluginManifestInput);
  return result.ok
    ? { ok: true, manifest: result.manifest, notes }
    : { ok: false, issues: result.issues, notes };
}
