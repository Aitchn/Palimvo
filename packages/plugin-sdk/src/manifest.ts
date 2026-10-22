/**
 * Plugin manifest v2: the `manifest.json` at the root of every plugin package.
 *
 * `PluginManifestInput` is what an author writes (most fields optional); the validator returns a
 * `PluginManifest` with every default filled in, which is what the rest of Palimvo works with.
 */

export const MANIFEST_VERSION = 2;

/** The plugin API generation a Palimvo build speaks; bumped only for breaking runtime changes. */
export const PLUGIN_API_VERSION = 1;

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MANIFEST_FILE = "manifest.json";
export const DEFAULT_MAIN_FILE = "main.js";

/** Text shown to people: one string, or a table by locale that must include `en`. */
export type LocalizedText = string | ({ en: string } & Record<string, string>);

export interface PluginPermissions {
  /** Vault folder patterns the plugin may read (see `globs.ts`). */
  read: string[];
  /** Vault folder patterns the plugin may write; changes are credited to the plugin. */
  write: string[];
  /** `false`: no network. Otherwise host names it may reach (`api.example.com`, `*.example.com`, or `*` for any). */
  network: false | string[];
}

export type SlotName = "toolbar" | "context-menu" | "command-palette" | "status-bar" | "settings";
export const SLOT_NAMES: readonly SlotName[] = [
  "toolbar",
  "context-menu",
  "command-palette",
  "status-bar",
  "settings",
];

export type HomeWidgetSize = "small" | "medium" | "large";

/** A full-page view listed in the sidebar (a kanban board, a timeline). */
export interface ViewContribution {
  id: string;
  name: LocalizedText;
  icon?: string;
}

/** A fenced code block language the plugin renders inside notes. */
export interface CodeBlockContribution {
  language: string;
  name?: LocalizedText;
}

/** A type usable in ```component blocks. */
export interface ComponentContribution {
  type: string;
  name: LocalizedText;
  description?: LocalizedText;
}

/** A file extension the vault accepts only while this plugin is enabled. */
export interface FileTypeContribution {
  /** Lowercase, without the dot. */
  extension: string;
  /** Served as this type; `application/octet-stream` when omitted. Never HTML, SVG, XML or script types. */
  mime?: string;
  /** Largest accepted file of this type. */
  maxBytes?: number;
  description?: string;
}

/** A viewer that draws files with these extensions (built-in ones or from `fileTypes`). */
export interface ViewerContribution {
  id: string;
  name: LocalizedText;
  extensions: string[];
}

/** A view type for `.base` databases next to table and cards. */
export interface BaseViewContribution {
  type: string;
  name: LocalizedText;
}

export interface HomeWidgetContribution {
  id: string;
  name: LocalizedText;
  size?: HomeWidgetSize;
}

/** A point other plugins may contribute to. */
export interface ExtensionPointContribution {
  id: string;
  name?: LocalizedText;
  description?: LocalizedText;
}

/** A point of another plugin (listed in `dependencies`) this plugin contributes to. */
export interface ExtensionUse {
  plugin: string;
  point: string;
}

/** An entry in a host-drawn menu, bar or palette; its content runs in the sandbox. */
export interface SlotContribution {
  slot: SlotName;
  id: string;
  title: LocalizedText;
  icon?: string;
}

/** A CSS-variable theme: the only layer that touches the host's own styles. */
export interface ThemeContribution {
  name: LocalizedText;
  /** Path of the stylesheet inside the package. */
  css: string;
}

/** A whole-page application that takes over the main area, keeping navigation and sign-in. */
export interface AppContribution {
  name: LocalizedText;
  icon?: string;
}

/** An MCP tool that runs in the server-side sandbox; offered as `<plugin-id>.<name>`. */
export interface ToolContribution {
  /** Lowercase letters, digits and underscores. */
  name: string;
  /** English, shown to AI clients. */
  description: string;
  /** JSON Schema (`type: "object"`) the server validates arguments against. */
  inputSchema: Record<string, unknown>;
  /** True when the tool never changes the vault; lets clients skip confirmation. */
  readOnly?: boolean;
}

export interface Contributions {
  views: ViewContribution[];
  codeBlocks: CodeBlockContribution[];
  components: ComponentContribution[];
  fileTypes: FileTypeContribution[];
  viewers: ViewerContribution[];
  baseViews: BaseViewContribution[];
  homeWidgets: HomeWidgetContribution[];
  extensionPoints: ExtensionPointContribution[];
  extensions: ExtensionUse[];
  slots: SlotContribution[];
  theme?: ThemeContribution;
  app?: AppContribution;
  tools: ToolContribution[];
}

export interface PluginManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  /** Lowercase letters, digits and hyphens; the folder name and the MCP tool prefix. */
  id: string;
  /** `major.minor.patch[-pre]`. */
  version: string;
  name: LocalizedText;
  description?: LocalizedText;
  author?: string;
  license?: string;
  homepage?: string;
  /** Oldest Palimvo version this plugin works with. */
  minPalimvo?: string;
  permissions: PluginPermissions;
  /** Other plugins this one needs: id -> version range. */
  dependencies: Record<string, string>;
  contributes: Contributions;
  /** Browser entry (runs in the sandboxed iframe). */
  main: string;
  /** Server entry (runs in the QuickJS sandbox); required when `contributes.tools` is not empty. */
  server?: string;
  /** Plugin-owned UI strings: locale -> JSON file in the package. */
  locales?: Record<string, string>;
}

/** What an author writes: everything the validator can default is optional. */
export type PluginManifestInput = Omit<
  PluginManifest,
  "permissions" | "dependencies" | "contributes" | "main"
> & {
  permissions?: Partial<PluginPermissions>;
  dependencies?: Record<string, string>;
  contributes?: Partial<Contributions>;
  main?: string;
};

/** Typed identity function so `manifest.ts` files in plugin projects get completion and checking. */
export function defineManifest(manifest: PluginManifestInput): PluginManifestInput {
  return manifest;
}

/** Counts and sizes the validator enforces. */
export const MANIFEST_LIMITS = {
  nameLength: 80,
  descriptionLength: 500,
  shortText: 100,
  globsPerList: 50,
  networkHosts: 20,
  dependencies: 20,
  views: 20,
  codeBlocks: 20,
  components: 20,
  fileTypes: 20,
  viewers: 20,
  baseViews: 10,
  homeWidgets: 10,
  extensionPoints: 20,
  extensions: 20,
  slots: 30,
  tools: 40,
  toolDescriptionLength: 500,
  inputSchemaBytes: 16 * 1024,
  fileTypeMaxBytes: 100 * 1024 * 1024,
  locales: 20,
  /** Whole package, enforced when installing (T32); listed here so every layer uses one number. */
  packageBytes: 8 * 1024 * 1024,
  packageFiles: 200,
} as const;

/** Notes, canvases and bases have their own editors: a plugin cannot take over their extensions. */
export const EDITOR_EXTENSIONS: ReadonlySet<string> = new Set(["md", "canvas", "base"]);

/** Languages and base view types the core already owns. */
export const RESERVED_CODE_BLOCKS: ReadonlySet<string> = new Set([
  "component",
  "mermaid",
  "math",
  "base",
]);
export const RESERVED_BASE_VIEWS: ReadonlySet<string> = new Set(["table", "cards", "list", "map"]);

/** The name a tool has to MCP clients. */
export function qualifiedToolName(pluginId: string, tool: string): string {
  return `${pluginId}.${tool}`;
}

/** Picks the text for `locale`, then its language, then English, then any. */
export function resolveLocalized(text: LocalizedText | undefined, locale: string): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  const language = locale.split("-")[0] ?? locale;
  return text[locale] ?? text[language] ?? text.en;
}

/** Every package file the manifest points at, for the installer to check and the hash to cover. */
export function referencedFiles(manifest: PluginManifest): string[] {
  const files = new Set<string>([MANIFEST_FILE, manifest.main]);
  if (manifest.server) files.add(manifest.server);
  if (manifest.contributes.theme) files.add(manifest.contributes.theme.css);
  for (const path of Object.values(manifest.locales ?? {})) files.add(path);
  return [...files];
}
