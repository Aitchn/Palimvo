# Writing plugins

A plugin is a folder (or ZIP) with a `manifest.json` and the files it names. Palimvo runs its
browser code in a sandboxed iframe and its server code (MCP tools) in a QuickJS sandbox. A person
approves each exact version before anything runs. Design reasons:
[ADR 0017](../adr/0017-plugin-manifest-v2.md) (manifest) and
[ADR 0019](../adr/0019-plugin-web-host.md) (browser host). This page is a first draft; the UI
layers are described under [Changing the interface](#changing-the-interface); server tools under [server.js](#serverjs-mcp-tools). The installer and the library are
described under [Installing, approving and the library](#installing-approving-and-the-library).

```
my-plugin/
├─ manifest.json     required
├─ main.js           browser entry (ES module, default export = activate function)
├─ server.js         server entry, only when the plugin has MCP tools
├─ theme.css         only when it contributes a theme
└─ locales/en.json   strings used at run time, one file per locale
```

## manifest.json

```json
{
  "manifestVersion": 2,
  "id": "kanban",
  "version": "1.0.0",
  "name": { "en": "Kanban board", "zh-TW": "看板" },
  "description": { "en": "Show notes as cards on a board." },
  "minPalimvo": "0.1.0",
  "permissions": { "read": ["**"], "write": ["projects"], "network": false },
  "dependencies": { "base-tools": "^1.0.0" },
  "contributes": {
    "views": [{ "id": "board", "name": { "en": "Board" } }],
    "codeBlocks": [{ "language": "kanban" }]
  },
  "main": "main.js"
}
```

| Field                 | Notes                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion`     | Always `2`.                                                                                                                         |
| `id`                  | Lowercase letters, digits, hyphens (max 64). Also the prefix of its MCP tools: `<id>.<tool>`.                                       |
| `version`             | `major.minor.patch[-pre]`.                                                                                                          |
| `name`, `description` | A string, or `{ "en": "...", "zh-TW": "..." }` (English required).                                                                  |
| `minPalimvo`          | Oldest Palimvo version it works with.                                                                                               |
| `permissions`         | `read` / `write`: folder patterns; `network`: `false` or host names. See below.                                                     |
| `dependencies`        | Other plugins it needs: `id -> version range` (`^1.0.0`, `>=1.0.0 <2.0.0`, `*`). A plugin runs only while its dependencies can run. |
| `contributes`         | What it adds. See below.                                                                                                            |
| `main`                | Browser entry, default `main.js`.                                                                                                   |
| `server`              | Server entry; required when `contributes.tools` is not empty.                                                                       |
| `locales`             | `{ "en": "locales/en.json" }`: run-time strings, read with `palimvo.i18n.t(key)`.                                                   |

Unknown fields are errors. Run the validator while developing:

```ts
import { validateManifest } from "@palimvo/plugin-sdk";

const result = validateManifest(JSON.parse(text), { palimvoVersion: "0.1.0" });
if (!result.ok) console.error(result.issues); // [{ path, code, message }]
```

### Permissions

- `read` and `write` list vault folders. A name without wildcards is a folder (and everything in
  it): `decisions` covers `decisions/0001-a.md`. `*` matches inside one path segment, `**` any
  number of segments: `notes/*` covers `notes/a.md` only, `notes/**` and `**` cover everything
  below. Matching is case sensitive, on vault-relative paths.
- `write` changes are saved in the history under the plugin's name, on behalf of whoever used it.
- `network` is `false` (the iframe's content-security policy blocks every request) or a list of
  hosts such as `["api.example.com", "*.cdn.example.com"]`. `"*"` means any host and is flagged on
  the approval screen.
- Whatever the manifest declares, a call also needs the acting person to have that permission.

### Contributions

| Key               | Entry                                                       | Registered in `main.js` with     |
| ----------------- | ----------------------------------------------------------- | -------------------------------- |
| `views`           | `{ id, name, icon? }`: page listed in the sidebar           | `ui.registerView(id, render)`    |
| `codeBlocks`      | `{ language, name? }`: fenced block in notes                | `ui.registerCodeBlock(...)`      |
| `components`      | `{ type, name, description? }`: type for `component` blocks | `ui.registerComponent(...)`      |
| `fileTypes`       | `{ extension, mime?, maxBytes?, description? }`             | none; the vault accepts the file |
| `viewers`         | `{ id, name, extensions[] }`: draws files; needs `read`     | `ui.registerViewer(id, render)`  |
| `baseViews`       | `{ type, name }`: view type for `.base` files               | `ui.registerBaseView(...)`       |
| `homeWidgets`     | `{ id, name, size? }`                                       | `ui.registerHomeWidget(...)`     |
| `extensionPoints` | `{ id, name?, description? }`: others may contribute        | `extensions.invoke(point, in)`   |
| `extensions`      | `{ plugin, point }`: contribute to a dependency's point     | `extensions.contribute(...)`     |
| `slots`           | `{ slot, id, title, icon? }` in a host-drawn menu or bar    | `ui.registerSlot(slot, id, ...)` |
| `theme`           | `{ name, css }`: CSS variables only                         | none                             |
| `app`             | `{ name, icon? }`: takes over the main area                 | `ui.registerApp(render)`         |
| `tools`           | `{ name, description, inputSchema, readOnly? }`: MCP tools  | `server.js` (below)              |

Names the core owns are reserved (code block languages
`component`, `mermaid`, `math`, `base`; base views `table`, `cards`, `list`, `map`; the note
extensions `md`, `canvas`, `base`). File types may not use HTML, SVG, XML or script media types:
files are always served as inert downloads.

## Changing the interface

Three layers, from the least to the most a plugin can change. Design:
[ADR 0020](../adr/0020-plugin-ui-layers.md). One example of each is in `plugins/examples/`.

### 1. Theme (`contributes.theme`)

A stylesheet of colours and fonts. It is the only thing a plugin puts into the app's own page, so
the host parses it and keeps a small subset; the rest is dropped (the plugin settings do not
fail, the dropped parts simply have no effect).

- Rules may use `:root`, `:root[data-theme="light"]`, `:root[data-theme="dark"]` or
  `[data-theme="light"|"dark"]` as their only selector.
- Declarations may set custom properties (`--accent: #6c8cff`) and `color-scheme`, `font-family`,
  `font-size`, `line-height`, `letter-spacing`. See `apps/web/src/styles/tokens.css` for the
  variables the app reads.
- Values may not contain `url()`, `image-set()`, `src()`, `expression()`, `javascript:`,
  `data:`, backslash escapes, braces, `;`, `<`, `>`, `@` or `!important`. At-rules (`@import`,
  `@media`, `@font-face`) and nested blocks are dropped. Up to 64 KB.
- Themes win over the app's own tokens without `!important` (the host writes each selector with
  the same specificity as the app's and places the sheet later in the page).
- A person picks one in **Settings → Plugin theme**; the choice is kept on that device.

### 2. Slots (`contributes.slots`)

The app draws the frame; the plugin supplies what happens. Register each entry with
`ui.registerSlot(slot, id, handler)`.

| Slot              | The app draws                               | Handler                          |
| ----------------- | ------------------------------------------- | -------------------------------- |
| `toolbar`         | a button in the top bar (icon or title)     | `run(context)`                   |
| `context-menu`    | an item in the file tree's right-click menu | `run(context)`, `context.path`   |
| `command-palette` | a command in the palette (Ctrl+Shift+P)     | `run(context)`                   |
| `status-bar`      | an item in the bar under the main area      | `run(context)`                   |
| `settings`        | a section titled with the entry's title     | `render({ el })`, drawn in frame |
| `inspector`       | a section in the details panel, per file    | `render({ el, path })`, in frame |

- `title` is shown by the app (localised); `icon` is used when it names one of the app's own
  icons, otherwise toolbar entries show the title and the other slots show no icon.
- `visible(context)` is optional and decides per moment whether the entry shows (for example
  only on `.md` files). It must answer within 5 seconds; a plugin that fails or stays silent is
  hidden. `run` has 30 seconds.
- `context.path` is the open or clicked file. It is left out when the plugin's `permissions.read`
  does not cover it, so a slot never tells a plugin about files it may not read.
- `inspector` sections sit in the right-hand details panel under the open file's name. The frame
  stays while the person moves between files and is told the new `path` (left out when the plugin
  may not read that file), so draw from `context.path` each time `render` runs. There is no
  `visible` question for this slot: draw nothing when there is nothing to show.
- Entries run in the plugin's hidden frame, with the plugin's own permissions. Nothing a plugin
  sends is put into the page: there is no way to supply HTML for the frame.

### 3. App (`contributes.app`)

`ui.registerApp(render)` draws the whole main area, like a view that fills the page, and is
listed under **Plugin apps** in the sidebar (address `?app=<plugin id>`). The app's own rail,
sidebar, top bar and sign-in stay; opening any file or page ends the takeover.

## main.js

```ts
import { definePlugin } from "@palimvo/plugin-sdk";

export default definePlugin((palimvo) => {
  palimvo.ui.registerView("board", async ({ el }) => {
    const hits = await palimvo.vault.search("status:");
    (el as HTMLElement).textContent = palimvo.i18n.t("cards", { count: hits.length });
  });
});
```

`palimvo.vault` (`read`, `readBinary`, `list`, `search`, `queryBase`, `graph`, `write`, `propose`),
`palimvo.ui`, `palimvo.events` (`file:changed`, `file:opened`, `theme:changed`, `locale:changed`),
`palimvo.i18n` and `palimvo.extensions` are typed in `packages/plugin-sdk/src/api.ts`. Calls
reject with an error whose `code` is `permission_denied`, `not_found`, `version_conflict`,
`quota_exceeded`, `invalid_argument` or `unavailable`.

### What the browser host guarantees

Your `main.js` runs in a frame with an opaque origin: no cookies or storage, no access to the app
page, no forms, popups or navigation. Without the `network` permission nothing leaves the frame;
with it only the listed hosts are reachable, and scripts can never be loaded from the network
(bundle what you need into `main.js`). Every `palimvo.vault` call is checked against your
declared folders and against the rights of the person using the plugin. Paths with `..`,
backslashes, `.palimvo` or `.git` are rejected, and listings, searches and database rows only
show files in your folders. A frame that navigates away from its page is stopped.

Each contribution is its own frame: a home widget, a page, a viewer each start `main.js` again,
so keep activation cheap and register only what the manifest declares (registering something it
does not declare throws). `palimvo.ui.registerHomeWidget(id, render)` fills a card on the vault
home; the widget's `id` is what a home page's `{ "type": "plugin", "plugin", "view" }` block
names. A render function may return a cleanup. `el` is the frame's body: draw into it, and the
frame grows with the content (widgets, code blocks) or fills its box (pages, viewers).
The app's colors are available as CSS variables (`--bg`, `--fg`, `--accent`, `--border`, ...) and
the frame follows light and dark.

## How the browser loads a plugin

The browser lists `GET /api/vaults/:vault/plugin-runtime` (running plugins only) and fetches
`GET /api/vaults/:vault/plugin-runtime/:id` for the text of `main`, the locale files and the theme
stylesheet. It validates the manifest again and refuses a bundle whose hash is not the listed one.

## server.js (MCP tools)

```js
globalThis.__plugin = {
  tools: {
    list_open: async ({ tree }) => {
      const files = await vault.list({ dir: "decisions" });
      return { count: files.length };
    },
  },
};
```

`server.js` is a separate file from `main.js` (it runs on the server, `main.js` in the browser) and
is bundled into one script. Every tool in `contributes.tools` needs an entry in
`globalThis.__plugin.tools`: an `async` function that takes the arguments object and returns
anything JSON can hold. Tools appear to AI clients as `<plugin-id>.<tool>` through `list_tools` /
`call_tool`, only in vaults where the plugin runs. A vault administrator can also list them in
`tools/list` of `/mcp/<vault>` (`PUT /api/vaults/:vault/plugin-tools` with `{ "listed": true }`).
Arguments are validated against `inputSchema` before your code runs; a tool without
`readOnly: true` requires a `reason` from the caller, like every change.

The sandbox is QuickJS (ES2023, no Node APIs). Design: [ADR 0003](../adr/0003-plugin-tool-sandbox.md).

| In the sandbox                             |                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `vault.read({ path })`                     | The text of a note or text file (up to 1 MiB).                                                        |
| `vault.list({ dir? })`                     | Paths of the files below a folder (at most 2000).                                                     |
| `vault.search({ q, limit?, dir? })`        | `[{ path, matches? }]`, best matches first (at most 50).                                              |
| `vault.write({ path, content })`           | Saves the file; returns `{ path, version }`. The history credits the plugin acting for the AI client. |
| `vault.propose({ path, content, title? })` | Creates an edit proposal instead of saving; a person reviews it. Returns `{ id, state }`.             |
| `console.log(...)`                         | Up to 100 lines, returned next to the result as `logs`.                                               |

- Every `vault` function returns a promise and takes one object. Await them; a call you do not wait
  for may finish after your tool has returned.
- A call fails when the path is outside the folders your manifest declares, or the caller may not
  do that there. The error reaches your code as an exception with a message starting
  `permission_denied:` that you can catch.
- Limits per call: 5 seconds in all (host calls included), 32 MB of QuickJS heap inside a 64 MB
  hard ceiling, 256 KB of stack, 200 `vault` calls, 1 MiB of result. A plugin that goes over is
  stopped and its worker replaced; other plugins' calls are not affected.
- Each call starts in a fresh context: globals and changes to built-in prototypes do not carry over
  to the next call. There is no `fetch`, `require`, `process`, timer or `import()`.
- Use `console.log` while developing; the lines come back in the tool result.

## Approval and the content hash

A plugin runs only after a person approves its hash: SHA-256 over every file in the package
(`computePluginHash` in the SDK; the rule is documented in `hash.ts`). Changing any byte, in any
file, requires approval again.

## Installing, approving and the library

Design: [ADR 0018](../adr/0018-plugin-installation-and-library.md).

- **Package checks.** Before anything is stored the server checks the file list (at most
  `MANIFEST_LIMITS.packageFiles` = 200 files and `packageBytes` = 8 MiB in total; paths of letters,
  digits, `_`, `-` and `.`, no hidden files, no two paths that differ only by case), the manifest
  (the SDK validator, including `minPalimvo`), that **every file the manifest names exists**
  (`main`, `server`, theme CSS, locales) and that locale files are JSON objects. A package that
  fails is refused with `plugin_invalid` and the list of problems.
- **In a vault.** `POST /api/vaults/:vault/plugins` (needs `plugin.install`) installs a package
  into `.palimvo/plugins/<id>/`, from the library (`{ "library": { "id", "version"? } }`) or from
  files (`{ "files": [{ "path", "text" | "base64" }] }`). It starts switched off. The files are in
  the vault, so they are in its history and backups.
- **Approval.** `POST .../plugins/:id/approve` with the hash shown on the review screen
  (`GET .../plugins/:id` and `.../package`). Only a signed-in **person** with `plugin.approve`
  can do it; tokens and AI cannot. The approval is for that exact hash in that vault and is kept
  in the server database (`plugin_approvals`), so a vault copied to another server starts
  unapproved. One changed byte is a new hash and needs a new approval; putting back bytes that
  were approved before is approved again.
- **Running.** A plugin runs when it is switched on, its hash is approved, and every plugin it
  `dependencies` on (right id, version in range) runs too; a cycle runs nothing. The state
  (`running`, `disabled`, `needs_approval`, `blocked` with reasons) is in every list response.
  `PluginManager.load` re-reads and re-hashes the files each time the host or sandbox asks for
  them, so files edited on disk after approval never run (`plugin_not_approved`).
- **Rights while running.** The manifest declares the most a plugin may ask for; at run time a
  call is allowed only if the manifest covers the path **and** the person using it holds the
  permission there (`pluginMayAccess`).
- **Library.** The server keeps published packages in `<data>/library/plugins/<id>/<version>/`
  (index in `library_plugins`). `POST /api/plugin-library` (needs `library.publish`) adds a
  version; versions are immutable. The official plugins in the repository's `plugins/` folder are
  added at start-up when their files pass the checks (a folder whose files are not there yet is
  skipped with a warning; `plugins/examples/` is never added) and cannot be removed. They are only
  in the library: nothing is installed in a vault until a person chooses it. A development build that still reports version `0.0.0` accepts every `minPalimvo`, so the official plugins work from a checkout.

- **Web host endpoints.** `GET /api/vaults/:vault/plugin-runtime` (needs `vault.view`) lists the
  running plugins as `{ plugins: [{ id, version, hash, manifest }] }`. `GET .../plugin-runtime/:id`
  returns `{ id, hash, files }`, the text of `main`, the locale files and the theme stylesheet,
  after the files are re-hashed (`plugin_not_approved` otherwise). The host checks that `hash`
  matches the list.

## Official plugins to learn from

[`plugins/`](../../plugins/README.md) holds the plugins that ship in the library (`kanban`, with a
page, a code block and an extension point, and `kanban-due`, a contributor to it) and, under
`plugins/examples/`, small plugins that are never added to the library: `json-tree` (a viewer),
`chart-pack` (component types) and the UI-layer demos. All have tests. Note how they keep to the sandbox:
no storage (state lives in memory), styles in an inline `<style>` that use the app's CSS
variables, strings through `palimvo.i18n.t`, and every render function returning a cleanup when
it listens to events.

## Moving a version 1 plugin

`convertLegacyManifest(oldManifest)` returns a version 2 manifest and a list of notes about
anything that changed meaning, for example the old `network` permission becoming `["*"]`.
Review the notes and narrow the permissions before publishing.
