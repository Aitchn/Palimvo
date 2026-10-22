# MCP server

How AI clients reach Palimvo. Design reasons are in [ADR 0014](../adr/0014-mcp-tool-registry.md);
how they sign in is in [AI tokens and OAuth](./ai-tokens-and-oauth.md).

- `/mcp`: every vault the caller can see; vault-scoped tools take a `vault` argument.
- `/mcp/:vault`: one vault; tools take no `vault`.
- Stateless Streamable HTTP, POST only. `X-Palimvo-Author: ai:<client name>` credits the client in
  history; `X-Palimvo-Reason` can stand in for the `reason` argument.

## Adding a tool

```ts
// apps/server/src/mcp/tools/notes.ts
export const readNote = defineTool<z.ZodObject, McpDeps>({
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

Register it in `tools/index.ts`. Return any JSON value, or `toolContent([...])` for MCP content
blocks. Throw `AppError` for expected failures; the AI sees its code and message.

Plugin tools: implement `ToolProvider.toolsFor(vaultId)` and pass it in `AppDeps.toolProviders`.

`test/mcp.test.ts` shows how to drive the server with the official SDK client; keep
`tools/list` under `TOOLS_LIST_BUDGET_BYTES`.
