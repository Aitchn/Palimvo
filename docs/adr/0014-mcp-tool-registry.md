# 0014. MCP server and tool registry

- Status: accepted
- Date: 2026-10-22

## Context

AI clients connect to `/mcp` (OAuth or token, several vaults) and `/mcp/:vault` (token, one
vault). The previous version listed 53 tools on every connection, which costs 10 to 15 thousand
tokens of context before the AI does anything, and plugin tools would have made it grow without
limit. The assistant built into the web app (M12) will use the same tools, so they cannot be tied
to the HTTP transport.

## Decision

- **One registry, one dispatcher.** A tool is `defineTool({ name, tier, scope, permission, input,
description, writes, handler })`. Every call, from `tools/call` or through `call_tool`, goes
  through the same dispatcher: find the tool, check its permissions with `accessOf(c)` (so token
  limits, roles, overrides and propose-only tokens apply exactly as in the REST API), validate
  the arguments with zod, run the handler, audit changes. Handlers never read token fields.
- **Two tiers.** `native` tools (about 20) are in `tools/list`. `advanced` tools (about 25) and
  every plugin tool are reached with three native entry tools: `list_tools` (names and one line
  each, filter by `query` and `vault`), `describe_tool` (full text and JSON Schema) and
  `call_tool`. Plugins supply tools through a `ToolProvider` per vault; whatever tier they claim
  they are advanced, and they cannot shadow a core tool.
- **`tools/list` shows only what the caller can use.** A tool appears if the caller holds all its
  permissions in the endpoint's vault, or in at least one visible vault on `/mcp`. A read-only
  token does not see write tools. Tokens have no server-scope permissions (ADR 0013), so
  server-wide tools never appear for them; `create_vault`/`remove_vault` in T29 need a decision
  on how an administrator's OAuth grant gets there.
- **`vault` and `reason` are added by the registry.** On `/mcp` vault-scoped tools get a required
  `vault`; on `/mcp/:vault` they do not, and a different `vault` is `token_scope_denied`. Tools
  with `writes: true` get a required `reason` (an `X-Palimvo-Reason` header also satisfies it),
  which the handler receives as `ctx.note` for the history. The author is the AI client's name
  from `X-Palimvo-Author`, or else the token's / OAuth app's name.
- **Failures are results.** A refused or failed tool call returns `isError` with
  `{ error: { code, message, details } }` so the AI can read it and react; unexpected errors are
  logged and shown as `internal` without their message.
- **Stateless transport.** A new protocol `Server` per POST; nothing to lose on restart. GET and
  DELETE answer 405. The bearer middleware (ADR 0013) runs first, including the per-token rate
  limit; it is mounted once on `/mcp/*`, because that pattern also matches `/mcp` and a second
  registration counted every request twice.
- **Budget.** `tools/list` must stay under 24 KB (`TOOLS_LIST_BUDGET_BYTES`), asserted in tests
  for both endpoints; T28 and T29 add the real tools under that test.

## Consequences

- Adding a tool is one file and one line in `tools/index.ts`; permissions, audit and the size
  check come with it.
- Plugin tools cost nothing per connection but need a `list_tools` round trip; the server
  instructions tell the AI to do that.
- The registry works on plain `z.object` inputs (no refinements), since `vault` and `reason` are
  merged in with `extend`.
