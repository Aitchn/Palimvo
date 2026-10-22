# MCP server

How AI clients reach Palimvo. Design reasons are in [ADR 0014](../adr/0014-mcp-tool-registry.md);
how they sign in is in [AI tokens and OAuth](./ai-tokens-and-oauth.md).

- `/mcp`: every vault the caller can see; vault-scoped tools take a `vault` argument.
- `/mcp/:vault`: one vault; tools take no `vault`.
- Stateless Streamable HTTP, POST only. `X-Palimvo-Author: ai:<client name>` credits the client in
  history; `X-Palimvo-Reason` can stand in for the `reason` argument.

## The native tools

Listed on every connection (`tools/list`). Everything below takes `vault` on `/mcp`; changes also
take `reason`.

| Area    | Tools                                                                                 |
| ------- | ------------------------------------------------------------------------------------- |
| Find    | `list_vaults` (`/mcp` only; shows access and enabled plugins), `list_files`, `search` |
| Read    | `read_note` (notes, canvases, bases, text files), `get_backlinks`, `read_canvas`      |
| Write   | `create_note`, `update_note` (edits / append / content), `move_note`, `delete_note`   |
| Data    | `set_note_property`, `query_base`                                                     |
| Canvas  | `edit_canvas` (add/update/remove nodes and edges in one call)                         |
| History | `get_history`, `get_diff`                                                             |
| Files   | `upload_file`, `download_file` (base64, up to 64 MiB)                                 |
| Entry   | `list_tools`, `describe_tool`, `call_tool` (advanced and plugin tools)                |

Edits of one file by several clients are queued per file (`modifyText` in `tools/shared.ts`) and
applied to the newest text. Tokens limited to folders only see those folders. Design reasons:
[ADR 0015](../adr/0015-native-mcp-tools-and-admin-grants.md).

## Advanced tools

Not in `tools/list`; found with `list_tools` and run with `call_tool` (same permissions, audit and
history as a listed tool). They appear only when the caller may use them.

| Area      | Tools                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| Structure | `create_folder`, `get_graph` (best connected notes first, `limit`, readable folders only)                             |
| Versions  | `create_checkpoint` (your `reason` is its description, optional `tag`), `restore_version` (one file, as a new change) |
| Data      | `create_base` (database from a folder and/or tags, columns, table or cards)                                           |
| Files     | `list_file_types`                                                                                                     |
| Admin     | `create_vault`, `remove_vault` (`/mcp` only, see below)                                                               |
| Plugins   | `list_plugins`, `list_library_plugins`, `read_plugin`; admin grants also get the ones below                           |

Still to come with the services they need: components (`add_component`...), chunked
uploads and upload links (T22), vault settings.

### Plugin tools

A plugin that runs in a vault can add MCP tools (`contributes.tools`, code in its `server.js`). They
are named `<plugin-id>.<tool>`, are found with `list_tools` (pass `vault` on `/mcp`) and run with
`call_tool`, and exist only in vaults where the plugin is switched on, approved and its
dependencies run. Their code runs in a QuickJS sandbox on a worker pool; what it may read and write
is its manifest's folders limited to what the caller may do, and its changes are credited to the
plugin acting for the AI client. A tool that is not `readOnly` needs a `reason`. A vault
administrator can list a vault's plugin tools in `tools/list` of `/mcp/<vault>` as well
(`PUT /api/vaults/:vault/plugin-tools`, `{ "listed": true }`); `/mcp` keeps its short list. The
number of workers is `PALIMVO_PLUGIN_WORKERS` (default 4). See
[plugins](plugins.md#serverjs-mcp-tools) and [ADR 0003](../adr/0003-plugin-tool-sandbox.md).

### Plugin management

Anyone who can view a vault can list its plugins, list the server's plugin library and read an
installed plugin (`list_plugins`, `list_library_plugins`, `read_plugin`). Changing them is
administration, because tokens never carry `plugin.install`: `install_plugin` (files you wrote),
`install_library_plugin`, `set_plugin_enabled` and `uninstall_plugin` need an admin grant and
`plugin.install` held by the person; `publish_library_plugin` and `remove_library_plugin` need an
admin grant and `library.publish`. An installed plugin starts switched off and **cannot be
approved over MCP**: a person approves its exact hash in the web app, so an AI can propose a
plugin but never run one. See [plugins](plugins.md#installing-approving-and-the-library).

### Administration

`create_vault` and `remove_vault` exist only for an OAuth connection the person allowed to
administer (a box on the consent page, offered to people who may create vaults or publish plugins;
needs "Read and write"). API tokens, other OAuth grants and `/mcp/:vault` never see them. The grant
holds at most `vaults.create` and `library.publish` at server level, cut down to what the person
holds on every call. `create_vault` makes the person its administrator. `remove_vault` needs
`vault.settings` in that vault (the person's own right), the vault id repeated as `confirm`, and
only moves the vault to the trash; restoring stays in the web app. Both are audited
(`vault.created`, `vault.removed`, next to the generic `mcp.<tool>` line). Design:
[ADR 0015](../adr/0015-native-mcp-tools-and-admin-grants.md),
[ADR 0016](../adr/0016-advanced-mcp-tools.md).

## Adding a tool

```ts
// apps/server/src/mcp/tools/notes.ts
export const readNote = mcpTool({
  name: "read_note",
  tier: "native", // or "advanced": only reachable through list_tools / call_tool
  // adminGrant: true, // only for OAuth grants the person allowed to administer (ADR 0015)
  scope: "vault", // "server" for tools that are not about one vault
  permission: "note.read", // all of these must be held; checked before the arguments are parsed
  input: z.object({ path: z.string() }), // plain object; do not declare `vault` or `reason`
  description: "Read a note.", // English, short; it is sent on every connection
  writes: false, // true: `reason` is required and the call is audited
  handler: async ({ path }, ctx) => {
    // ctx.vault, ctx.access (requireTree for folder rules), ctx.author, ctx.note, ctx.deps
    return { path };
  },
});
```

`mcpTool` (from `tools/shared.ts`) is `defineTool` with the server dependencies filled in, so
`args` is typed from `input`. Register it in `tools/index.ts`. Return any JSON value, or `toolContent([...])` for MCP content
blocks. Throw `AppError` for expected failures; the AI sees its code and message.

Plugin tools: implement `ToolProvider.toolsFor(vaultId)` (and `prepare(vaultId)` when it needs async data) and pass it in `AppDeps.toolProviders`; `PluginToolProvider` is the one that serves plugins.

`test/mcp.test.ts` shows how to drive the server with the official SDK client; keep
`tools/list` under `TOOLS_LIST_BUDGET_BYTES`.
