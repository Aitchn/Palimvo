# 0013. AI tokens and OAuth

- Status: accepted
- Date: 2026-10-22

## Context

AI clients reach a vault through `/mcp`. People connect them in two ways: by pasting a token
(Claude Code, Cursor) or through OAuth (Claude.ai, ChatGPT). Whichever way, an AI must never do
more than the person who connected it, and it must lose rights the moment that person does.

## Decision

- **A token stores a limit, not a permission.** An API token records its access level (`read`,
  `write` or `propose`), an optional vault and optional folders. Nothing about what its owner may
  do is copied into it. On every call the owner's current permissions are recomputed with
  `resolvePermissions` and cut down with T51's `intersect` (`RequestAccess.mask`). Demoting the
  owner, adding a deny override, removing them from the vault or disabling the account narrows
  or ends their tokens on the very next call. The owner must also still hold `mcp.connect` in the
  vault. Tokens never carry administration: server scope is always empty, and the access levels
  exclude restore, review, plugin and settings permissions.
- **Refusals say why.** A `propose` token asking for a direct write gets `propose_only`; a token
  used outside its vault or folders gets `token_scope_denied`; a person who lost the right to
  connect AI gets `forbidden`.
- **Secrets.** `plm_…` API tokens and `plo_`/`plr_`/`plc_…` OAuth secrets are 256 random bits,
  shown once and stored as SHA-256 hashes (they are random, so a plain hash is enough and allows
  a direct lookup). API tokens expire after 90 days unless the maker picks another time or none.
  At most 100 active tokens per person. Each token or grant is rate limited per minute (600 by
  default, 1 to 6000 per token), in memory, which is enough for one server process.
- **Only a browser session can make or revoke tokens**, never a token. Administrators with
  `users.manage` can list and revoke anyone's. Creating, revoking and every OAuth grant, grant
  ending and client registration are written to the audit log.
- **`/mcp` accepts bearer secrets only.** The cookie is ignored there, so a web page cannot drive
  the endpoint with a visitor's session. A missing or bad secret gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="<public url>/.well-known/oauth-protected-resource"`.
  Until the MCP server arrives (T27) an authorized call is answered `501 not_implemented`.
- **OAuth 2.1 for MCP clients.** Discovery (RFC 9728 protected-resource metadata, RFC 8414 server
  metadata), dynamic client registration (RFC 7591), authorization code with PKCE `S256` only,
  rotating refresh tokens, revocation (RFC 7009), `iss` in the authorization response (RFC 9207).
  Access tokens last 1 hour, refresh tokens 30 days, codes 5 minutes. A spent authorization code
  or refresh token presented again means a leak: the whole grant is revoked.
- **The grant covers every vault the person may connect AI to**, at the access level they choose
  on the consent page (default write, or whatever the app asked for with `mcp:read`,
  `mcp:write`, `mcp:propose`). A person who may connect AI nowhere is refused.
- **Return addresses are the trust anchor.** They must be `https`, `http` on a loopback host, or
  an app scheme (not `javascript:`, `data:`, …), have no fragment, and match a registered one
  exactly. A wrong client or address shows an error page and never redirects. Registration is
  open but bounded: 30 per hour per address, 2000 clients, unused clients dropped after 2 hours.
  The consent page says the app is unverified and shows where the person is sent next.
- **Pages.** The sign-in and consent pages are small server-rendered HTML in the browser's
  language (`oauth.*` in `@palimvo/i18n`), with no script, `frame-ancestors 'none'`, a CSRF token
  bound to the session and an origin check. App names are stripped of markup and escaped.
- **`PALIMVO_PUBLIC_URL` is required for OAuth.** Without it every discovery, registration and
  authorize endpoint answers `503 public_url_required` (and the page says what to set). API
  tokens do not need it.
- **AI is credited as AI.** A token's changes are authored `ai:<name>`: the name the client gives
  in `X-Palimvo-Author`, else the OAuth app's name or the token's name.

## Consequences

- The web pages for making tokens and showing connection snippets (T14) only call
  `/api/tokens` and `/api/oauth/grants`.
- The OAuth `resource` parameter is checked to name this server's `/mcp`, but access tokens are
  not bound to one audience.
- A new access level or permission only needs `TOKEN_ACCESS_PERMISSIONS` to change; stored tokens
  follow.
