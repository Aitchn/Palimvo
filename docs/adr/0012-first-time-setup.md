# 0012. First-time setup

- Status: accepted
- Date: 2026-10-22

## Context

ADR 0010 left the API fully open while no account existed ("setup mode"). That is safe only when
nobody else can reach the server. A self-hosted server is often exposed (Docker with a published
port, a tunnel) before its owner has finished setting it up, and whoever arrives first would be
able to create the administrator.

## Decision

- **No account means setup mode, and setup mode is closed.** Every `/api` call except `health`,
  `auth/*` and `setup/*` answers `403 setup_required`. `GET /api/auth/me` returns
  `{ "state": "setup" }` so the web app can show the wizard.
- **Setup code.** On start, with no account, the server writes a one-time code (16 characters, no
  look-alikes, shown as `XXXX-XXXX-XXXX-XXXX`) to `<data>/setup-token` (mode 0600) and logs it. A
  restart keeps the same code. The file is deleted when setup finishes, and at start if an account
  already exists.
- **Local requests need no code.** A request counts as local only if the socket peer is loopback,
  it carries none of the headers a proxy or tunnel adds (`X-Forwarded-*`, `X-Real-IP`, `Forwarded`,
  `Via`, `CF-*`), and its `Host` is `localhost` or a loopback address. A reverse proxy on the same
  machine therefore does not turn the internet into "local", and a DNS-rebinding page is not local.
- **`POST /api/setup`** takes `{ code?, username, password, displayName?, vault: { id, sample } }`.
  It checks the code (constant-time, 10 wrong guesses per client address in 15 minutes, then
  `429`), validates everything, creates the vault, then in one SQLite transaction the administrator
  (server admin, vault admin of the first vault), the default roles (`@everyone`, `Creator`,
  `AI user`, `Reader` from the plan) and an audit entry. It signs the new administrator in, deletes
  the code and answers `201`. If the transaction fails the new vault is moved to the trash. Two
  simultaneous requests cannot both succeed. Afterwards it answers `403 setup_complete`.
  `vault.sample: true` adds a few English example notes and a canvas.
- **`GET /api/setup/status`** says whether setup is still required and whether this caller needs
  the code.
- **`--dev-insecure`** (`PALIMVO_DEV_INSECURE`) replaces the old "open until the first account"
  behaviour: with it, and no account, the API stays open and no code is written. Starting with it on
  a host that is not loopback (`127.x`, `::1`, `localhost`) is a configuration error.

## Consequences

- Tests that want the open API start the server with `devInsecure: true` (the test harness default);
  `test/setup.test.ts` covers the real flow.
- The `Reader` role is created without permissions; its "no writing" effect is a per-vault override
  applied when someone is given the role (T52/T53).
- The wizard UI is T14.
