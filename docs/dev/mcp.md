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

## Adding a tool

```ts
// apps/server/src/mcp/tools/notes.ts
export const readNote = mcpTool({
  name: "read_note",
  tier: "native", // or "advanced": only reachable through list_tools / call_tool
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

Plugin tools: implement `ToolProvider.toolsFor(vaultId)` and pass it in `AppDeps.toolProviders`.

`test/mcp.test.ts` shows how to drive the server with the official SDK client; keep
`tools/list` under `TOOLS_LIST_BUDGET_BYTES`.
