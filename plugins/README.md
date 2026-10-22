# Official plugins

Plugins shipped with the server (in the plugin library from the start; nothing is installed in a vault until a person chooses to) live here, one folder per plugin with a
`manifest.json` ([manifest v2](../docs/dev/plugins.md)).

| Folder       | Does                                    | Code lands in |
| ------------ | --------------------------------------- | ------------- |
| `decisions`  | decision notes, status, 4 MCP tools     | ready         |
| `kanban`     | board view and `kanban` code block      | ready         |
| `kanban-due` | due-date badges for the board           | ready         |
| `graph`      | link graph page and a local graph panel | ready         |

Each plugin folder has its own `README.md`, `main.js` and `locales/{en,zh-TW,zh-CN}.json`. The
`decisions` has its tools (`server.js`) but no page yet: the timeline arrives with T37.
`kanban` + `kanban-due` also show an extension point.

## Examples

`examples/` holds small plugins for plugin authors, one per kind of contribution. They are never
seeded into the server library (`PluginManager.seedBuiltins` skips the folder, and a test locks it).

| Folder                    | Shows                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `examples/theme-midnight` | a CSS-variable theme (`contributes.theme`)                                              |
| `examples/slots-demo`     | an entry in every UI slot: toolbar, context menu, command palette, status bar, settings |
| `examples/hello-app`      | a whole-page application (`contributes.app`)                                            |
| `examples/chart-pack`     | component types for `component` blocks (radar, treemap, sparkline)                      |
| `examples/json-tree`      | a file viewer (`contributes.viewers`) with search and folding                           |

Tests: `apps/web/src/plugins/official.test.ts` (logic of the board, due dates and both examples)
and `tests/e2e/official-plugins.spec.ts` (in a browser, in the real sandbox).
