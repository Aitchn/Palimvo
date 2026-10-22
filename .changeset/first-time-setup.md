---
"@palimvo/server": minor
"@palimvo/core": patch
"@palimvo/i18n": patch
---

First-time setup: until the first administrator exists the server only answers the setup endpoints. A one-time code in `<data>/setup-token` (not needed from the same machine) protects `POST /api/setup`, which creates the administrator, the default roles and the first vault. The old open mode is now `--dev-insecure`, allowed only on a loopback address.
