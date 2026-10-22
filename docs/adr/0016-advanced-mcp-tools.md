# 0016. Advanced MCP tools and the administration flag

- Status: accepted
- Date: 2026-10-22

## Context

ADR 0014 gave the registry an `advanced` tier reached through `list_tools`, `describe_tool` and
`call_tool`; ADR 0015 planned the administration flag for OAuth grants. T29 fills the advanced
tier with the tools whose services exist today and adds the flag.

## Decision

- **Tools now:** `create_folder`, `get_graph`, `create_checkpoint`, `restore_version`,
  `create_base`, `list_file_types`, `create_vault`, `remove_vault`. Tools that need services that
  do not exist yet (plugins and the plugin library, components, chunked uploads,
  upload links, vault settings) are added with those services, as the plan allows; each is one
  `mcpTool` plus a test.
- **The flag is stored in the grant's `scope`** as the word `mcp:admin` next to `mcp:write`, so no
  database migration is needed and old grants stay as they are. It only counts with `mcp:write`;
  the consent form and the permission limit both enforce that. The box is offered to people who
  hold `vaults.create` or `library.publish`, and a forged `admin=1` from anyone else is refused.
- **The limit.** `TokenScope.admin` makes `intersect` keep `vaults.create` and `library.publish`
  at server scope and nothing else (`ADMIN_GRANT_PERMISSIONS`); inside vaults it changes nothing.
  The "owner may connect AI" check (`mcp.connect`) applies per vault, so it no longer zeroes the
  server scope.
- **`remove_vault` and `vault.settings`.** Token access levels never include `vault.settings`, so
  a tool that declares `adminGrant: true` is checked against the person's own permissions inside
  the vault (`RequestAccess.personCan`, still requiring `mcp.connect` there) in addition to the
  grant. It is hidden from everyone without the grant and refused with a message that says why.
  It moves the vault to the trash exactly like the web route and repeats the vault id as `confirm`.
- **`restore_version` restores one file** with `note.write` (and `history.view`), folder rules
  included. Restoring is writing the file again with older text, which a write token may do anyway;
  `history.restore` (whole-vault restore) stays for people and is not handed to AI clients.
- **`create_checkpoint` uses the call's `reason` as the checkpoint's message** instead of a second
  free-text argument.

## Consequences

- An AI with an admin grant can create vaults and remove them into the trash, nothing else
  administrative; accounts, roles, keys and the audit log are out of reach.
- `publish_library_plugin` is not offered until T32 provides the library service; the grant
  already carries `library.publish` for it.
- The web page that lists AI connections (not built yet) should show the `admin` field of
  `GET /api/oauth/grants` as "can administer".
