---
"@palimvo/server": minor
"@palimvo/core": patch
"@palimvo/i18n": patch
---

AI connections: API tokens limited to an access level, vault and folders (never more than the person who made them, recomputed on every call), and OAuth 2.1 with PKCE and dynamic client registration so Claude.ai and ChatGPT can connect to `/mcp`. Needs `PALIMVO_PUBLIC_URL`.
