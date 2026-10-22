# 0015. Native MCP tools and administration through OAuth

- Status: accepted
- Date: 2026-10-22

## Context

ADR 0014 gave the server a tool registry with two tiers. T28 fills the native tier: the tools
every connection lists. The previous version listed 53 tools; the aim is about 20 including the
three entry tools, so that `tools/list` stays well under 24 KB. Two questions came up on the
way: how AI edits should behave when several clients change the same file, and how an
administrator's OAuth grant can reach `create_vault`, `remove_vault` and
`publish_library_plugin` (T29), since ADR 0013 gives tokens no server-scope permissions.

## Decision

### The native tools

`list_vaults`, `list_files`, `read_note`, `search`, `get_backlinks`, `create_note`,
`update_note`, `move_note`, `delete_note`, `set_note_property`, `read_canvas`, `edit_canvas`,
`get_history`, `get_diff`, `upload_file`, `download_file`, `query_base`, plus `list_tools`,
`describe_tool`, `call_tool`. `create_edit_proposal` joins them with the proposal store (T25);
until then a propose-only token can read but not change anything, and is told so by
`propose_only`.

- **Few tools, several modes.** `update_note` takes `edits` (find/replace pairs applied in
  order, all or none, a find that is missing or ambiguous is an error naming the edit),
  `append`, or a whole `content`. `edit_canvas` takes a list of operations (`add_node`,
  `update_node`, `add_edge`, `update_edge`, `remove`) applied all or none; new nodes can be given
  an id so later operations in the same call can connect them, and nodes without a position are
  stacked below the existing ones.
- **Concurrent AI edits are queued, not retried blindly.** A read-modify-write of one file runs
  one at a time in the server (a per-file queue shared by `update_note`, `set_note_property` and
  `edit_canvas`), and the write still carries the version it read. If something else (a person, a
  REST call) wrote in between, the edit is applied again to the newest text, up to 8 times. So
  three clients appending to one note all land. When live editing (T16) arrives, the single
  function `modifyText` in `tools/shared.ts` is where the edit moves into the live document.
- **Folder-limited tokens read only their folders.** The permission model limits folders only
  for write-type rights at folder scope; the tools ask `note.read` at the folder of each path,
  filter listings, search, backlinks, history and databases to readable paths, and refuse
  `get_diff` without a `path` (a whole-change diff would show other files).
- **Results are small and bounded.** `read_note` cuts at 100 000 characters (`truncated`,
  `length`), `get_diff` at 60 000, search and listings are paged. `download_file` returns small
  images as MCP image content so the model can look at them; everything else as base64. Uploads
  and downloads are limited to 64 MiB, the same as the web app (`DEFAULT_MAX_FILE_BYTES`).
- **Plugins in `list_vaults`.** `McpDeps.plugins` (a `PluginCatalog`) says which plugins are
  enabled per vault. The plugin platform supplies it; until then no vault lists any.

### Administration through OAuth (implemented with the tools in T29)

Tokens and grants keep an empty server scope (ADR 0013). The plan wants three administrative
tools on `/mcp`. The smallest safe way:

1. **Opt-in per grant, OAuth only.** The consent page shows an unchecked box "Also allow this
   app to administer the server" only to people who hold `vaults.create` or `library.publish`
   (or are administrators). The grant stores `admin: true`. API tokens (pasted secrets) never
   get it.
2. **Still the person's rights, cut down.** With the flag, the server-scope permissions of the
   grant are the person's current server permissions limited to `vaults.create` and
   `library.publish`, recomputed on every call like all other limits. Never `server.manage`,
   `users.manage`, `roles.manage`, `assistant.manage` or `audit.view`: an AI can not touch
   accounts, roles, provider keys or the audit log.
3. **The tools.** `create_vault` needs `vaults.create` (the creator becomes its vault
   administrator). `publish_library_plugin` needs `library.publish`; a person still approves
   each plugin version by hash before it runs. `remove_vault` needs the `vault.settings`
   permission in that vault and the admin flag, takes the vault id again as `confirm`, and only
   moves the vault to the trash; restoring from the trash stays in the web app.
4. **Visible and revocable.** The grants page shows "can administer" next to such a grant;
   revoking it ends it. Granting, and every call of these tools, is audited.

## Consequences

- Most clients (Claude Code with a token) never see administrative tools, and a leaked token can
  not create or remove vaults.
- Adding the flag touches `TokenScope`/`intersect`, the consent page and the grants page, which
  is why it goes with T29 and not into this change.
- Until T25, AI clients that may only propose have nothing to write with.
