# 0013. Web sign-in, setup wizard and settings

- Status: accepted
- Date: 2026-10-22

## Context

Accounts, sessions, invites (ADR 0010), permissions (ADR 0011) and first-time setup (ADR 0012) exist
on the server, but the web app knew nothing about them: it never signed in, never sent the CSRF
token, and offered every editing control to everyone.

## Decision

- **One answer first.** The app asks `GET /api/auth/me` before showing anything. The answer
  (`setup`, `open`, `guest`, `account`) lives in a `SessionProvider`. `setup` sends every address to
  `/setup`; `guest` may browse what the server shows to guests and gets a sign-in link; protected
  pages (`/settings/*`) send guests to `/login?next=…`. `next` is followed only when it is a path
  inside this site.
- **CSRF.** The token from `me`, login, invite accept or setup is kept in memory (`setCsrfToken`)
  and sent as `X-Palimvo-Csrf` on every non-GET request. It is never written to storage. When any
  call answers `unauthenticated` the client raises one window event and the session provider asks
  `me` again, so an expired session turns into the guest view instead of a pile of errors.
- **Offline.** If `me` cannot be reached because there is no connection, the shell still opens
  (the offline bar says so) and nothing is offered for editing; coming back online asks again.
  Any other failure shows an error with a retry button.
- **Wizard** (`/setup`): welcome (language, theme, setup code only when the server asks), the
  administrator account, the first vault with optional example notes. It posts once to
  `POST /api/setup` and lands in the new vault. Validation mirrors the server (10 characters, vault
  id rules) so people see problems before sending, but the server stays the judge.
- **Settings** (`/settings/…`) are full pages, not a dialog: _Account_ (profile, language, theme,
  password, signed-in devices), _People_ (users, roles on a user, invites; needs `users.manage`),
  _Vaults_ (create, remove, restore; per-vault _Members_ and _Public access_). A section appears only
  when the permissions from `GET /api/me/permissions` allow it. The small settings dialog in the
  workspace stays for language and theme and links here.
- **Read-only screens.** `useVaultPermissions` asks the same endpoint per vault. Until the answer
  arrives nothing that changes files is offered; without `note.write` there are no new-note,
  new-folder, rename or move controls and the editor is view-only, without `note.delete` no delete,
  without `file.upload` no import. This only avoids offering what would be refused; the server
  checks every request.

## Consequences

- Role _management_ (create, colour, order, overrides) is T53; this task only assigns existing roles.
- The AI connection page (tokens, copy-paste snippets) waits for the token and OAuth API (T12).
- A vault administrator without `users.manage` can manage members who are already in the vault but
  cannot pick new people to add, because listing all accounts needs `users.manage`. A server API for
  looking people up by name would fix that.
- No server-wide settings page yet: there is no server settings API.

## Alternatives considered

- Keeping the token in a cookie readable by script: rejected, the session cookie is `HttpOnly` on
  purpose (ADR 0010).
- Rendering the whole app and letting each call fail when signed out: rejected, it leaves guests
  and people with expired sessions looking at error boxes.
