# Official plugins

Plugins shipped with the server (in the plugin library from the start; nothing is installed in a vault until a person chooses to) live here, one folder per plugin with a
`manifest.json` ([manifest v2](../docs/dev/plugins.md)).

| Folder       | Does                                          | Code lands in |
| ------------ | --------------------------------------------- | ------------- |
| `decisions`  | decision notes, status, timeline, 4 MCP tools | T36           |
| `kanban`     | board view and `kanban` code block            | ready         |
| `kanban-due` | due-date badges for the board                 | ready         |
| `chart-pack` | radar, treemap and sparkline components       | ready         |
| `json-tree`  | collapsible viewer for `.json`                | ready         |

Each plugin folder has its own `README.md`, `main.js` and `locales/{en,zh-TW,zh-CN}.json`. The
`decisions` folder still holds only its manifest; the loader skips a folder whose `main` file is
missing until the code arrives (T36).

They are also the examples to copy from: `kanban` + `kanban-due` show an extension point,
`json-tree` a file viewer, `chart-pack` component types, and all four show how run-time strings
are read with `palimvo.i18n.t`. Tests: `apps/web/src/plugins/official.test.ts` (logic) and
`tests/e2e/official-plugins.spec.ts` (in a browser, in the real sandbox).
