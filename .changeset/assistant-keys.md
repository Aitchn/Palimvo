---
"@palimvo/server": minor
"@palimvo/core": patch
"@palimvo/i18n": patch
---

Assistant: administrators can add model providers and API keys on the server. Keys are encrypted in the database, never shown again (only the last four characters), and can also come from environment variables. Includes connection testing, model refresh, enabling models and a default model and reasoning level.
