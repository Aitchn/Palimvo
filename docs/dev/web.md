# Web app

`apps/web` is a React 19 single-page app built with Vite. This page describes the shell that every
feature plugs into.

## Layout

```
src/
  app/        routes and the pages that exist so far (vault list, not found)
  workspace/  a vault's page: sidebar, tabs, file view, deep links (see "Files and tabs")
  files/      file tree, file operations, drop import, quick-open helpers
  commands/   command registry, palette, fuzzy matching
  api/        client.ts (the only fetch), errors.ts, one module per domain (vaults, files, …)
  i18n/       i18next set-up, language switch
  theme/      light / dark / system, theme menu
  shell/      Shell (layout v2), Rail, Tabs, layout state, settings dialog
  ui/         Button, Dialog, Sheet, Menu, Icon, Skeleton, Toast
  styles/     tokens.css (colours, shape, motion), motion.css, base.css, ui.css, shell.css
  pwa/        service-worker registration, standalone-mode CSS
```

## Talking to the server

Call the domain modules in `src/api/`, never `fetch`. Every failure is an `ApiError` whose `code`
is one of the server's error codes (`@palimvo/core`) or `network` / `unknown`. Show it with
`describeError(t, error)`, which looks up `errors.<code>` in the current language. Adding a server
error code therefore means adding `errors.<code>` to all three locale files; a test enforces it.

## Languages

Locale files live in `packages/i18n/locales/`. The web app imports them only through
`@palimvo/i18n/load`, which splits each language into its own chunk: a visitor downloads English
(the fallback) and the language they use, nothing else. The first language is the saved choice
(`palimvo.locale`), else the browser's language list, else English. Messages use ICU syntax
(plurals, placeholders). Never write interface text into a component; use `t("key")`.

## Themes

`palimvo.theme` holds `system`, `light` or `dark`. A script in `index.html` applies it before the
first paint. The old `aitchn.theme` key is read once and moved. Components use the CSS variables
in `tokens.css`, never raw colours.

## Layout v2

Wide screens: icon rail, collapsible sidebar, top bar with tabs, main area, optional details
panel. The open or closed state is remembered in `palimvo.layout`. At 900px and below the sidebar
and details panel become drawers (`Sheet`), dialogs become bottom sheets, and nothing stays open
behind the page. Feature code passes `sidebar`, `inspector` and `tabs` content to `<Shell>`.

## PWA

`vite.config.ts` writes `/sw.js` from `sw-template.js` with the build's file list. The worker
caches only the app shell. `/api`, `/mcp`, `/oauth` and `/.well-known` always go to the network,
so notes and credentials are never stored by the worker. Offline note access is a later task.
Regenerate the PNG icons from `public/icons/palimvo.svg` with `pnpm icons`.

## Files and tabs

`/v/:vault/*` is the workspace; everything after the vault is the file's vault path, so
`/v/notes/Projects/Plan.md` is a link anyone with access can open (`workspace/deepLinks.ts` builds
and reads them). Opening an address adds a tab and opens the folders above the file. Open tabs and
open folders are remembered per vault in `palimvo.tabs.<vault>` and `palimvo.expanded.<vault>`.

- **Tree** (`files/FileTree.tsx`): an ARIA tree that only renders the rows near the viewport, so
  size does not matter. Arrow keys, Home/End, Enter, F2 (rename), Delete, and the context-menu key
  work; each row also has a "…" button for touch screens. `useVaultTree` loads the tree and then
  asks the server every 5 seconds with `If-None-Match`; an unchanged tree costs one 304.
- **Changes** (`files/useFileOperations.ts`): create, rename, move (drag a row onto a folder),
  delete (with confirmation), import. A name that is taken is refused before any request. Moving
  or deleting keeps tabs and the address bar pointing at the right place.
- **Import**: drop files or folders on the tree, or use the import button. Only text files are
  imported for now (binary uploads come with the upload task); a name already in use gets a number
  (`Note 2.md`), nothing is overwritten.
- **ZIP**: "Download as ZIP" on a folder, or the whole vault, calls
  `GET /api/vaults/:vault/archive?path=<folder>` (see [vault-files.md](vault-files.md)).
- **Quick open** (Ctrl/Cmd+P) matches the typed letters against file paths (`commands/fuzzy.ts`);
  the open tabs come first when nothing is typed.
- **Commands** (Ctrl/Cmd+Shift+P): `commands/registry.ts` holds the list. Call
  `registerCommands([{ id, title, run }])` (it returns an undo function) to add commands; plugins
  will use the same door. Titles must already be translated.

Until the editor task lands, the main area shows the text of Markdown, canvas, base and common
text files read-only.

## Tests

- `pnpm --filter @palimvo/web test`: unit and component tests (jsdom).
- `pnpm build && pnpm e2e`: Playwright against the built app with a mocked API. It writes
  screenshots (desktop / phone × light / dark × English / 繁體中文) to `tests/e2e/screenshots/`,
  which CI uploads as an artifact, and checks the manifest, installability and the service worker.
  Set `PLAYWRIGHT_CHROMIUM_PATH` to use an existing Chromium instead of `playwright install`.
