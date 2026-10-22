# Writing plugins

A plugin is a folder (or ZIP) with a `manifest.json` and the files it names. Palimvo runs its
browser code in a sandboxed iframe and its server code (MCP tools) in a QuickJS sandbox. A person
approves each exact version before anything runs. Design reasons:
[ADR 0017](../adr/0017-plugin-manifest-v2.md) (manifest) and
[ADR 0019](../adr/0019-plugin-web-host.md) (browser host). This page is a first draft; the UI
layers (T33) and server tools (T34) land in later changes. The installer and the library are
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

Slots: `toolbar`, `context-menu`, `command-palette`, `status-bar`, `settings`. The host draws the
frame; your content runs in the sandbox. Names the core owns are reserved (code block languages
`component`, `mermaid`, `math`, `base`; base views `table`, `cards`, `list`, `map`; the note
extensions `md`, `canvas`, `base`). File types may not use HTML, SVG, XML or script media types:
files are always served as inert downloads.

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

`palimvo.vault` (`read`, `readBinary`, `list`, `search`, `queryBase`, `write`, `propose`),
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

The browser lists `GET /api/vaults/:vault/plugins`, runs the entries whose `state` is `running`
(enabled, approved at exactly the current hash, dependencies met) and reads `manifest.main`, the
`locales` files and a theme stylesheet from `GET /api/vaults/:vault/plugins/:id/files/<path>`. The
server re-hashes the package before it serves a file. The browser validates the manifest again.

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

The sandbox has a `vault` global (`read`, `list`, `search`, `write`, `propose`, each taking one
object) and a `console.log`; there is no network, file system, timer or `require`. Tools appear
to AI clients as `<plugin-id>.<tool>` through `list_tools` / `call_tool`, only in vaults where the
plugin is enabled. Arguments are validated against `inputSchema` before your code runs.

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
  skipped with a warning) and cannot be removed.

## Moving a version 1 plugin

`convertLegacyManifest(oldManifest)` returns a version 2 manifest and a list of notes about
anything that changed meaning, for example the old `network` permission becoming `["*"]`.
Review the notes and narrow the permissions before publishing.
