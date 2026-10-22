# Official plugins

Plugins shipped with the server (disabled by default) live here, one folder per plugin with a
`manifest.json` ([manifest v2](../docs/dev/plugins.md)).

| Folder       | Does                                          | Code lands in |
| ------------ | --------------------------------------------- | ------------- |
| `decisions`  | decision notes, status, timeline, 4 MCP tools | T36           |
| `kanban`     | board view and `kanban` code block            | T35           |
| `kanban-due` | due-date badges for the board                 | T35           |
| `chart-pack` | radar, treemap and sparkline components       | T35           |
| `json-tree`  | collapsible viewer for `.json`                | T35           |

For now these folders hold only the manifests (validated by the plugin SDK tests); the loader must
skip a folder whose `main` file is missing until the code arrives.

## Examples

`examples/` holds one small plugin per UI layer for plugin authors. They are not seeded into the
server library.

| Folder                    | Shows                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `examples/theme-midnight` | a CSS-variable theme (`contributes.theme`)                                              |
| `examples/slots-demo`     | an entry in every UI slot: toolbar, context menu, command palette, status bar, settings |
| `examples/hello-app`      | a whole-page application (`contributes.app`)                                            |
