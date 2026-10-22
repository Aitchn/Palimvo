import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { AppError, isAppError } from "@palimvo/core";
import { accessOf } from "../auth/access.ts";
import { createDispatcher, type McpDeps } from "./dispatch.ts";
import { instructions } from "./instructions.ts";
import { isToolContent, jsonSchemaOf, type Target, type ToolRegistry } from "./registry.ts";

/** Large enough for a 64 MiB file as base64 plus the JSON around it. */
export const MAX_MCP_BODY_BYTES = 92 * 1024 * 1024;

/** `tools/list` must stay small enough to be cheap on every connection (about 6k tokens). */
export const TOOLS_LIST_BUDGET_BYTES = 24 * 1024;

/** Browser-based MCP clients send a preflight before the bearer-protected call. */
export const mcpCors = cors({
  origin: "*",
  allowHeaders: [
    "Authorization",
    "Content-Type",
    "MCP-Protocol-Version",
    "Mcp-Session-Id",
    "X-Palimvo-Author",
    "X-Palimvo-Reason",
  ],
  allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
  exposeHeaders: ["WWW-Authenticate"],
});

export interface McpServerDeps {
  deps: McpDeps;
  registry: ToolRegistry;
  version: string;
}

const text = (value: unknown): CallToolResult["content"] => [
  { type: "text", text: typeof value === "string" ? value : (JSON.stringify(value) ?? "null") },
];

/** How a tool failure reaches the AI: as a result it can read and react to, not a protocol error. */
function failure(err: unknown, deps: McpDeps, tool: string): CallToolResult {
  if (isAppError(err)) {
    return {
      isError: true,
      content: text({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
      }),
    };
  }
  deps.logger.error("mcp tool failed", { tool, error: String(err) });
  return {
    isError: true,
    content: text({ error: { code: "internal", message: "Something went wrong on the server." } }),
  };
}

function buildServer(
  { deps, registry, version }: McpServerDeps,
  c: Parameters<typeof createDispatcher>[0]["c"],
  target: Target,
) {
  const dispatcher = createDispatcher({ c, registry, deps, target });
  const server = new Server(
    { name: "palimvo", version },
    { capabilities: { tools: {} }, instructions: instructions(target.endpoint) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await dispatcher.list()).map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: jsonSchemaOf(def, target.endpoint) as { type: "object" },
      annotations: {
        readOnlyHint: def.writes !== true,
        destructiveHint: def.writes === true && def.destructive === true,
        openWorldHint: false,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    try {
      const out = await dispatcher.call(name, args);
      return isToolContent(out)
        ? { content: out.content as CallToolResult["content"] }
        : { content: text(out ?? { ok: true }) };
    } catch (err) {
      return failure(err, deps, name);
    }
  });
  return server;
}

/**
 * `/mcp` (OAuth or token; every vault the caller can see, `vault` is an argument) and
 * `/mcp/:vault` (one vault). Stateless Streamable HTTP: a fresh protocol server per request, so a
 * restart or a second instance never strands a session. The bearer middleware has already run.
 */
export function mcpRoutes(deps: McpServerDeps): Hono {
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_MCP_BODY_BYTES,
      onError: () => {
        throw new AppError("payload_too_large");
      },
    }),
  );

  const serve = async (c: Parameters<typeof accessOf>[0], target: Target) => {
    if (c.req.method !== "POST") {
      return c.json(
        { code: "invalid_request", message: "Only POST is supported (stateless Streamable HTTP)." },
        405,
        { Allow: "POST" },
      );
    }
    const access = accessOf(c);
    // A vault the caller cannot see answers like a vault that does not exist.
    if (target.endpoint === "vault") access.requireVault("vault.view", target.vault);
    const server = buildServer(deps, c, target);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  };

  app.all("/mcp", (c) => serve(c, { endpoint: "all" }));
  app.all("/mcp/:vault", (c) => serve(c, { endpoint: "vault", vault: c.req.param("vault") }));
  return app;
}
