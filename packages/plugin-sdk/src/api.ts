/**
 * Types of the runtime APIs a plugin sees. Nothing here is implemented in this package: the web
 * host (T31) provides `PalimvoApi` inside the sandboxed iframe, and the server (T34) provides
 * `ServerVaultApi` inside the QuickJS sandbox. The types live here so plugin projects can
 * compile against them.
 *
 * Every call is asynchronous and JSON-shaped. The host checks each call against the plugin's
 * declared permissions *and* the permissions of whoever is acting, and rejects with a
 * `PluginApiError` when either side says no.
 */

export type Unsubscribe = () => void;

/** The `code` values a rejected host call can carry. */
export type PluginErrorCode =
  | "permission_denied"
  | "not_found"
  | "version_conflict"
  | "quota_exceeded"
  | "invalid_argument"
  | "unavailable";

export interface PluginApiError extends Error {
  code: PluginErrorCode;
}

export interface VaultListEntry {
  path: string;
  name: string;
  kind: "file" | "folder";
  size?: number;
  /** ISO 8601. */
  modifiedAt?: string;
}

export interface VaultSearchHit {
  path: string;
  title: string;
  snippet?: string;
}

export interface WriteOptions {
  /** Recorded in the version history next to the plugin's name. */
  reason?: string;
}

export interface ProposeInput {
  path: string;
  content: string;
  title?: string;
  reason?: string;
}

export interface BaseQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

/** `palimvo.vault`: limited to the folders in `permissions.read` / `permissions.write`. */
export interface VaultApi {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  list(dir?: string, options?: { recursive?: boolean }): Promise<VaultListEntry[]>;
  search(query: string, options?: { limit?: number; folder?: string }): Promise<VaultSearchHit[]>;
  queryBase(path: string, options?: { view?: string }): Promise<BaseQueryResult>;
  /** Writes a file (needs `permissions.write`); returns the new revision. */
  write(path: string, content: string, options?: WriteOptions): Promise<{ revision: string }>;
  /** Suggests a change a person reviews instead of writing it. */
  propose(input: ProposeInput): Promise<{ proposalId: string }>;
}

/** What a render function of a contribution receives. `El` is `HTMLElement` in the browser. */
export interface RenderContext<El = unknown> {
  /** The element the plugin draws into. */
  el: El;
  locale: string;
  theme: "light" | "dark";
}

export interface CodeBlockContext<El = unknown> extends RenderContext<El> {
  language: string;
  source: string;
  /** Path of the note that holds the block. */
  notePath: string;
  /** Replaces the block's source in the note (needs write access to the note). */
  update(source: string): Promise<void>;
}

export interface ComponentContext<El = unknown> extends RenderContext<El> {
  type: string;
  /** The block's YAML, parsed. */
  config: Record<string, unknown>;
  /** Values the host resolved from note properties and bases. */
  data: unknown;
}

export interface ViewerContext<El = unknown> extends RenderContext<El> {
  path: string;
  read(): Promise<Uint8Array>;
  readText(): Promise<string>;
}

export interface BaseViewContext<El = unknown> extends RenderContext<El> {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

/** A render function may return a cleanup, run when the host removes the element. */
export type Render<Ctx> = (context: Ctx) => void | (() => void) | Promise<void | (() => void)>;

export interface SlotContext {
  /** The note or file the user is acting on, when there is one. */
  path?: string;
  selection?: string;
}

/**
 * What a plugin does for one `contributes.slots` entry. The host draws the frame (the button, the
 * menu item, the palette row, the settings section); the plugin supplies what happens.
 *
 * - `toolbar`, `context-menu`, `command-palette`, `status-bar`: give `run`, called when the person
 *   picks the entry.
 * - `settings`: give `render`; its content is drawn in a sandboxed frame inside a settings section
 *   titled with the entry's title.
 */
export interface SlotHandler<El = unknown> {
  /** Called when the user picks the entry. */
  run?(context: SlotContext): void | Promise<void>;
  /** `settings` entries: draws the content of the section. */
  render?: Render<RenderContext<El>>;
  /** Return false to hide the entry for this context. */
  visible?(context: SlotContext): boolean;
}

/** `palimvo.ui`: every `register*` id must match a `contributes` entry of the manifest. */
export interface UiApi<El = unknown> {
  registerView(id: string, render: Render<RenderContext<El>>): Unsubscribe;
  registerCodeBlock(language: string, render: Render<CodeBlockContext<El>>): Unsubscribe;
  registerComponent(type: string, render: Render<ComponentContext<El>>): Unsubscribe;
  registerViewer(id: string, render: Render<ViewerContext<El>>): Unsubscribe;
  registerBaseView(type: string, render: Render<BaseViewContext<El>>): Unsubscribe;
  registerHomeWidget(id: string, render: Render<RenderContext<El>>): Unsubscribe;
  registerSlot(slot: string, id: string, handler: SlotHandler<El>): Unsubscribe;
  /** Draws the whole page of a `contributes.app` plugin. */
  registerApp(render: Render<RenderContext<El>>): Unsubscribe;
  showNotice(message: string, options?: { kind?: "info" | "success" | "error" }): void;
  openFile(path: string): void;
}

export interface FileChangedEvent {
  path: string;
  kind: "created" | "modified" | "deleted" | "moved";
  /** Author as shown in the history, e.g. "Mira" or "ai:Claude". */
  author: string;
  /** The old path when `kind` is "moved". */
  from?: string;
}

export interface PluginEvents {
  "file:changed": FileChangedEvent;
  "file:opened": { path: string };
  "theme:changed": { theme: "light" | "dark" };
  "locale:changed": { locale: string };
}

/** `palimvo.events`: events about files outside `permissions.read` are not delivered. */
export interface EventsApi {
  on<K extends keyof PluginEvents>(
    event: K,
    handler: (payload: PluginEvents[K]) => void,
  ): Unsubscribe;
}

/** `palimvo.i18n`: strings come from the files named in the manifest's `locales`. */
export interface I18nApi {
  readonly locale: string;
  /** Looks `key` up in the current locale, then English; returns the key when missing. `{name}` placeholders are filled from `params`. */
  t(key: string, params?: Record<string, string | number>): string;
}

/** `palimvo.extensions`: the contract between plugins (see `contributes.extensionPoints`). */
export interface ExtensionsApi {
  /** Asks every enabled contributor of one of this plugin's own points; returns their answers in plugin id order. */
  invoke<In = unknown, Out = unknown>(point: string, input: In): Promise<Out[]>;
  /** Contributes to a point of a plugin listed in `dependencies`. */
  contribute<In = unknown, Out = unknown>(
    plugin: string,
    point: string,
    handler: (input: In) => Out | Promise<Out>,
  ): Unsubscribe;
}

export interface PalimvoApi<El = unknown> {
  readonly plugin: { id: string; version: string };
  readonly vault: VaultApi;
  readonly ui: UiApi<El>;
  readonly events: EventsApi;
  readonly i18n: I18nApi;
  readonly extensions: ExtensionsApi;
}

/** The default export of a plugin's `main.js`. */
export type PluginActivate<El = unknown> = (palimvo: PalimvoApi<El>) => void | Promise<void>;

/** Typed identity function for `export default definePlugin(...)`. */
export function definePlugin<El = unknown>(activate: PluginActivate<El>): PluginActivate<El> {
  return activate;
}

/* ------------------------------------------------------------------------------------------ */
/* Server side: a plugin's `server.js`, run in the QuickJS sandbox (no network, files or timers). */

/** The `vault` global inside the server sandbox: the text-only part of `VaultApi`. */
export interface ServerVaultApi {
  read(args: { path: string }): Promise<string>;
  list(args: { dir?: string }): Promise<string[]>;
  search(args: { q: string }): Promise<string[]>;
  write(args: { path: string; content: string; reason?: string }): Promise<void>;
  propose(args: { path: string; content: string; title?: string; reason?: string }): Promise<void>;
}

/** A tool handler gets the arguments the server already validated against `inputSchema`. */
export type ToolHandler<Args = Record<string, unknown>> = (
  args: Args,
) => unknown | Promise<unknown>;

/** What `server.js` assigns to `globalThis.__plugin`. */
export interface PluginServerModule {
  tools: Record<string, ToolHandler>;
}

/** Typed identity function for `globalThis.__plugin = defineServer({ tools: { ... } })`. */
export function defineServer(module: PluginServerModule): PluginServerModule {
  return module;
}
