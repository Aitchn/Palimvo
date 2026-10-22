# Web app

`apps/web` is a React 19 single-page app built with Vite. This page describes the shell that every
feature plugs into.

## Layout

```
src/
  app/        routes and the pages that exist so far (vault list, workspace, not found)
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

## Tests

- `pnpm --filter @palimvo/web test`: unit and component tests (jsdom).
- `pnpm build && pnpm e2e`: Playwright against the built app with a mocked API. It writes
  screenshots (desktop / phone × light / dark × English / 繁體中文) to `tests/e2e/screenshots/`,
  which CI uploads as an artifact, and checks the manifest, installability and the service worker.
  Set `PLAYWRIGHT_CHROMIUM_PATH` to use an existing Chromium instead of `playwright install`.
