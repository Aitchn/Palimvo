# 0010. Accounts, cookie sessions and guest access

- Status: accepted
- Date: 2026-10-22

## Context

Task T10 adds the first access control. Roles and per-vault permissions arrive later (T51 computes
them, T52 enforces them on every route), so this layer must stand on its own and be easy to
replace route by route.

## Decision

- **Passwords** use scrypt (N=2^15, r=8, p=1) with a random salt, stored as
  `scrypt$N$r$p$salt$hash` so the cost can change later. Passwords are 10 to 256 characters and
  NFKC-normalized. A login for an unknown name still burns one hash so timing does not reveal names.
- **Sessions** are random 256-bit cookie values; only their SHA-256 is stored. The cookie is
  `HttpOnly; SameSite=Lax; Path=/` and `Secure` when `PALIMVO_PUBLIC_URL` is https. Sessions last 14
  days and slide forward once less than 7 days remain. Disabling, deleting or resetting an account
  ends its sessions; changing a password ends all other sessions.
- **CSRF**: for requests that carry a session cookie and use an unsafe method, the `Origin` header
  (when present) must match this site and `X-Palimvo-Csrf` must equal an HMAC of the cookie value
  that `GET /api/auth/me` and login return. The cookie is `HttpOnly`, so other sites cannot compute
  it. Requests without a session cookie have no ambient credentials and need no token.
- **Login throttling** is in memory: 10 failures per name and 40 per client address within 15
  minutes lead to `429 rate_limited`. A successful login clears the name's counter.
- **Invites** are one-time, expire (default 7 days, at most 30), and can name roles and vaults to
  grant. Only a hash of the secret is stored. The account is created and the invite consumed in one
  transaction, so two people cannot both use one link.
- **Setup mode**: while no account exists nothing is enforced (the server listens on loopback by
  default). T11 replaces this with the setup wizard. Once an account exists, requests without a
  session are guests.
- **Guests** may only `GET` the vault list, file tree, files and search. A vault is visible to
  guests only if it has public entries. Public entries are a vault (`""`), folders or files, stored
  in the `public_access` table; hidden (dot) paths are never public. Filtering happens in the
  routes, before data leaves the server; search is filtered before paging so totals do not leak.
  Everything else answers `401`.
- **Interim rules until T52**: signed-in accounts pass the access gate for vault routes; creating,
  removing and restoring vaults needs a server administrator; account and invite management needs a
  server administrator; managing a vault's public set needs a server administrator or a vault
  administrator. T52 replaces these checks with permission lookups.
- A browser session is always credited as that person in the history; the `X-Palimvo-Author` header
  is honored only in setup mode. AI tokens (T12) will carry their own client name.

## Consequences

- Until T52, any signed-in account can read and write every vault. Do not invite untrusted people
  to a server before T52 lands.
- Login throttling resets when the server restarts; acceptable for one process and bounded by scrypt cost.
