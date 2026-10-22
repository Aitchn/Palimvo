# AI tokens and OAuth

How AI clients authenticate against `/mcp`. Design reasons are in
[ADR 0013](../adr/0013-ai-tokens-and-oauth.md).

## API tokens (Claude Code, Cursor, scripts)

A signed-in person with `mcp.connect` makes one (the web app's AI connections page calls this):

```http
POST /api/tokens
{ "name": "Claude Code", "access": "write", "vaultId": "notes", "folders": ["projects"],
  "expiresInDays": 90, "rateLimitPerMinute": 600 }
```

`access` is `read`, `write` (read, write, delete, upload, propose) or `propose` (read and
propose; direct writes answer `propose_only`). Leave out `vaultId` for every vault the person can
connect AI to; `folders` need a `vaultId`. `expiresInDays: null` never expires. The response
holds the `secret` (`plm_…`) once. Use it as `Authorization: Bearer <secret>`.

- `GET /api/tokens` lists your tokens; `DELETE /api/tokens/:id` revokes one.
- `GET /api/admin/tokens` and `DELETE /api/admin/tokens/:id` need `users.manage`.
- `GET /api/oauth/grants` and `DELETE /api/oauth/grants/:id` list and end the OAuth connections;
  each grant says whether it `admin`isters (the person ticked "also allow administering": see
  [MCP server](./mcp.md#administration)).

## OAuth (Claude.ai, ChatGPT)

Set `PALIMVO_PUBLIC_URL` (for example `https://notes.example.com`). A client then finds everything
from a `401` on `/mcp`:

| Step                | Endpoint                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Discover            | `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server` |
| Register            | `POST /oauth/register` (JSON, RFC 7591)                                                  |
| Sign in and consent | `GET /oauth/authorize` (PKCE `S256` required)                                            |
| Tokens              | `POST /oauth/token` (`authorization_code`, `refresh_token`)                              |
| Revoke              | `POST /oauth/revoke`                                                                     |

## For code that handles `/mcp` requests

`app.ts` puts `bearerMiddleware` in front of `/mcp`. Inside a handler,
`accessOf(c).require("note.write", scope)` already applies the token: it returns what the owner
holds right now, limited to the token's access level, vault and folders. Use `requestAuthor(c)`
for history entries. Never read the token's stored fields to decide permissions.
