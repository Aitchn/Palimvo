---
"@palimvo/server": minor
---

MCP server at `/mcp` (every vault the connection can see) and `/mcp/:vault` (one vault), over stateless Streamable HTTP. Tools live in one registry that checks each caller's permissions, lists only what they can use, records the AI client as author with a required reason for changes, and audits changes. Three entry tools (`list_tools`, `describe_tool`, `call_tool`) reach advanced and plugin tools without lengthening `tools/list`.
