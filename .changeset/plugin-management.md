---
"@palimvo/server": minor
"@palimvo/core": patch
"@palimvo/i18n": patch
---

Plugins: install plugins into a vault, switch them on and off, and approve each exact version by its content hash (only a person can approve; one changed byte needs a new approval). Packages are checked before they are stored: referenced files must exist and size limits apply. The server has a plugin library that administrators publish to and owners install from, and AI clients with an administration grant can publish, install and manage plugins over MCP.
