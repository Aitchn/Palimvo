import { z } from "zod";
import { AppError } from "@palimvo/core";
import { ENTRY_TOOLS } from "./dispatch.ts";
import { defineTool, jsonSchemaOf, notFound, summary, type AnyTool } from "./registry.ts";

const MAX_LISTED = 100;

const vaultArg = z
  .string()
  .min(1)
  .optional()
  .describe("Vault whose plugin tools to include. Needed to see plugin tools on /mcp.");

/**
 * The three tools that reach everything not listed in `tools/list`: the advanced core tools and
 * the tools of enabled plugins. They keep the list short however many plugins a vault has.
 */
export function entryTools(): AnyTool[] {
  return [
    defineTool({
      name: "list_tools",
      tier: "native",
      scope: "server",
      permission: [],
      input: z.object({
        vault: vaultArg,
        query: z
          .string()
          .min(1)
          .optional()
          .describe("Only tools whose name or description contains this."),
        limit: z.number().int().min(1).max(MAX_LISTED).optional().describe("Default 50."),
      }),
      description:
        "List more tools you can use through call_tool: folders, graph, checkpoints, uploads, plugins, settings and the tools of plugins enabled in a vault. Returns names with one line each; use describe_tool for the arguments.",
      handler: async (args, ctx) => {
        const { dispatcher } = ctx;
        const all = await dispatcher.advanced(args.vault);
        const q = args.query?.toLowerCase();
        const matching = q
          ? all.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(q))
          : all;
        const limit = args.limit ?? 50;
        return {
          tools: matching.slice(0, limit).map((t) => ({
            name: t.name,
            summary: summary(t),
            ...(t.writes ? { writes: true } : {}),
          })),
          total: matching.length,
        };
      },
    }),
    defineTool({
      name: "describe_tool",
      tier: "native",
      scope: "server",
      permission: [],
      input: z.object({
        name: z.string().min(1).describe("A tool name from list_tools."),
        vault: vaultArg,
      }),
      description:
        "Full description and argument schema of a tool, as call_tool expects it. Check it before calling a tool you have not used.",
      handler: async (args, ctx) => {
        const { dispatcher } = ctx;
        const def = await dispatcher.describe(args.name, args.vault);
        if (!def) throw notFound(args.name);
        return {
          name: def.name,
          description: def.description,
          writes: def.writes === true,
          arguments: jsonSchemaOf(def, dispatcher.endpoint),
        };
      },
    }),
    defineTool({
      name: "call_tool",
      tier: "native",
      scope: "server",
      permission: [],
      input: z.object({
        name: z.string().min(1).describe("The tool to run."),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Its arguments, including vault and reason where describe_tool shows them."),
        vault: vaultArg,
      }),
      description:
        "Run a tool from list_tools. Same permissions and history as if it were listed directly; arguments are checked by the server.",
      handler: async (args, ctx) => {
        const { dispatcher } = ctx;
        if (ENTRY_TOOLS.has(args.name))
          throw new AppError("invalid_request", undefined, undefined, {
            message: `${args.name} is already available directly; call it without call_tool.`,
          });
        const inner = { ...args.arguments };
        if (args.vault !== undefined && inner.vault === undefined) inner.vault = args.vault;
        return dispatcher.call(args.name, inner);
      },
    }),
  ];
}
