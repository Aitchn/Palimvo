import type { AnyTool, Endpoint } from "../../mcp/registry.ts";
import { argumentsOf, jsonSchemaOf } from "../../mcp/registry.ts";
import type { ProviderTool } from "./types.ts";

/**
 * Shows a registry tool to the model. The assistant uses the same definitions as MCP clients, so
 * the descriptions and argument schemas are written once (T27, T28).
 */
export function toProviderTool(def: AnyTool, endpoint: Endpoint = "all"): ProviderTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: jsonSchemaOf(def, endpoint),
  };
}

export function toProviderTools(
  defs: readonly AnyTool[],
  endpoint: Endpoint = "all",
): ProviderTool[] {
  return defs.map((d) => toProviderTool(d, endpoint));
}

export type ToolInputCheck =
  { ok: true; input: Record<string, unknown> } | { ok: false; error: string };

/**
 * Checks what the model wrote against the tool's schema before anything runs. Models (small
 * local ones especially) send wrong types and missing fields; the error goes back to the model as
 * the tool result so it can correct itself.
 */
export function validateToolInput(
  def: AnyTool,
  input: unknown,
  endpoint: Endpoint = "all",
): ToolInputCheck {
  const parsed = argumentsOf(def, endpoint).safeParse(input);
  if (parsed.success) return { ok: true, input: parsed.data as Record<string, unknown> };
  const error = parsed.error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(input)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `Invalid arguments for ${def.name}: ${error}` };
}
