---
"@palimvo/server": minor
"@palimvo/core": patch
---

Plugins can add MCP tools. A plugin's `server.js` runs in a QuickJS sandbox on a pool of worker threads (`PALIMVO_PLUGIN_WORKERS`, default 4) with a hard memory ceiling, time limits, and a `vault` API (`read`, `list`, `search`, `write`, `propose`) checked against the plugin's declared folders and the caller's rights. Tools are named `<plugin-id>.<tool>`, appear through `list_tools` and `call_tool` only in vaults where the plugin runs, and can be listed in `tools/list` of `/mcp/<vault>` with `PUT /api/vaults/:vault/plugin-tools`.
