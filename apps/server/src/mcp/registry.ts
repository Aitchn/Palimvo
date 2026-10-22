import type { Context } from "hono";
import { z } from "zod";
import type { Author, PermissionName } from "@palimvo/core";
import { AppError, serverScope, vaultScope } from "@palimvo/core";
import type { RequestAccess } from "../auth/access.ts";
import type { ChangeNote } from "../history/history.ts";
import type { Dispatcher } from "./dispatch.ts";

/**
 * - `native`: listed in `tools/list`, so every connection sees it (about 20 of them).
 * - `advanced`: reached through the entry tools `list_tools`, `describe_tool` and `call_tool`.
 *   Plugin tools are always advanced, so more plugins never make `tools/list` longer.
 */
export type ToolTier = "native" | "advanced";

/** `all`: `/mcp`, one connection for every vault (`vault` is an argument). `vault`: `/mcp/:vault`. */
export type Endpoint = "all" | "vault";

/** What a tool handler can use, besides its parsed arguments. */
export interface ToolContext<Deps = unknown> {
  deps: Deps;
  /** Permission checks for this call; the tool's own `permission` is already checked. */
  access: RequestAccess;
  /** Who the history credits (the AI client's name). */
  author: Author;
  /** The reason the caller gave (always present for tools with `writes: true`), for the history. */
  note: ChangeNote;
  /** The vault this call is about; set for `scope: "vault"` tools. */
  vault: string;
  /** Which endpoint the call arrived on. */
  endpoint: Endpoint;
  /** Runs other tools as this caller; only the entry tools use it. */
  dispatcher: Dispatcher;
  /** The raw request, for the rare tool that needs it. */
  request: Context;
}

/** A tool result with explicit MCP content blocks (images, resources); anything else is sent as JSON text. */
const CONTENT = Symbol("palimvo.toolContent");
export interface ToolContent {
  [CONTENT]: true;
  content: { type: string; [key: string]: unknown }[];
}
export function toolContent(content: ToolContent["content"]): ToolContent {
  return { [CONTENT]: true, content };
}
export const isToolContent = (v: unknown): v is ToolContent =>
  typeof v === "object" && v !== null && CONTENT in v;

export interface ToolDef<S extends z.ZodObject = z.ZodObject, Deps = unknown> {
  /** `snake_case`, at most 64 characters; plugin tools are namespaced by their plugin. */
  name: string;
  tier: ToolTier;
  /** `vault`: the call is about one vault (adds the `vault` argument on `/mcp`). `server`: it is not. */
  scope: "vault" | "server";
  /** Every one of these must be held in the vault (or on the server) for the tool to be listed or run. */
  permission: PermissionName | readonly PermissionName[];
  /** Plain `z.object`; `vault` and `reason` are added by the registry, do not declare them. */
  input: S;
  /** English, short: it is paid for in the model's context on every connection. */
  description: string;
  /** Changes something: the caller must give a `reason`, and the call is audited. */
  writes?: boolean;
  /** Cannot be undone from the history (deletes). Only changes the hint shown to the AI. */
  destructive?: boolean;
  /** Defaults to both. `list_vaults` only makes sense on `/mcp`. */
  endpoints?: readonly Endpoint[];
  handler(args: z.infer<S>, ctx: ToolContext<Deps>): unknown | Promise<unknown>;
}

// The registry stores definitions with their argument type erased; defineTool keeps authors honest.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<z.ZodObject, any>;

export const MAX_DESCRIPTION = 700;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Declares a tool with its argument types checked against the handler. */
export function defineTool<S extends z.ZodObject, Deps = unknown>(def: ToolDef<S, Deps>): AnyTool {
  if (!NAME.test(def.name)) throw new Error(`Invalid tool name "${def.name}"`);
  if (def.description.length > MAX_DESCRIPTION)
    throw new Error(`Tool "${def.name}" has a description of ${def.description.length} characters`);
  // Server-wide tools may take their own optional `vault` (the entry tools do).
  for (const reserved of def.scope === "vault" ? ["vault", "reason"] : ["reason"])
    if (reserved in def.input.shape)
      throw new Error(`Tool "${def.name}" must not declare "${reserved}"; the registry adds it`);
  return def as unknown as AnyTool;
}

/** Tools a plugin (or any other module) supplies per vault; they are always advanced and cannot shadow core tools. */
export interface ToolProvider {
  toolsFor(vaultId: string): readonly AnyTool[];
}

export const permissionsOf = (def: AnyTool): readonly PermissionName[] =>
  typeof def.permission === "string" ? [def.permission] : def.permission;

/** The first sentence, for the one-line entries of `list_tools`. */
export function summary(def: AnyTool): string {
  const first = /^(.+?[.!?])(\s|$)/s.exec(def.description)?.[1] ?? def.description;
  return first.length > 140 ? `${first.slice(0, 137)}...` : first;
}

const VAULT_ARG = z.string().min(1).describe("The vault to use (see list_vaults).");
export const REASON_ARG = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .describe("Short reason for this change; it is recorded in the version history.");

/** What the caller must pass for `def` on `endpoint`: the tool's own arguments plus `vault` and `reason`. */
export function argumentsOf(def: AnyTool, endpoint: Endpoint, reasonOptional = false): z.ZodObject {
  const extra: Record<string, z.ZodType> = {};
  if (def.scope === "vault" && endpoint === "all") extra.vault = VAULT_ARG;
  if (def.writes) extra.reason = reasonOptional ? REASON_ARG.optional() : REASON_ARG;
  return def.input.extend(extra);
}

/** JSON Schema of the arguments, as `tools/list` and `describe_tool` show it. */
export function jsonSchemaOf(def: AnyTool, endpoint: Endpoint): Record<string, unknown> {
  const schema = z.toJSONSchema(argumentsOf(def, endpoint), { io: "input" }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  delete schema.additionalProperties;
  return schema;
}

export class ToolRegistry {
  private readonly core = new Map<string, AnyTool>();
  private readonly providers: ToolProvider[] = [];

  constructor(tools: readonly AnyTool[] = []) {
    for (const t of tools) this.add(t);
  }

  add(tool: AnyTool): this {
    if (this.core.has(tool.name)) throw new Error(`Tool "${tool.name}" is registered twice`);
    this.core.set(tool.name, tool);
    return this;
  }

  addProvider(provider: ToolProvider): this {
    this.providers.push(provider);
    return this;
  }

  /** Core tools, and the plugin tools of `vault` when one is given (they come last, as advanced). */
  all(vault?: string): AnyTool[] {
    const out = [...this.core.values()];
    if (vault === undefined) return out;
    for (const p of this.providers)
      for (const t of p.toolsFor(vault))
        if (!this.core.has(t.name) && !out.some((o) => o.name === t.name))
          out.push({ ...t, tier: "advanced" });
    return out;
  }

  find(name: string, vault?: string): AnyTool | undefined {
    return this.all(vault).find((t) => t.name === name);
  }
}

/** Where a request is aimed. */
export type Target = { endpoint: "all" } | { endpoint: "vault"; vault: string };

/** Whether `def` exists on this endpoint at all. */
export const onEndpoint = (def: AnyTool, endpoint: Endpoint): boolean =>
  (def.endpoints ?? ["all", "vault"]).includes(endpoint);

/** Whether the caller holds every permission of `def` in `vault` (or on the server). */
export function mayUse(access: RequestAccess, def: AnyTool, vault?: string): boolean {
  const scope =
    def.scope === "server" ? serverScope : vault === undefined ? undefined : vaultScope(vault);
  if (!scope) return false;
  // Seeing the vault is the baseline for every vault-scoped tool, whatever it declares.
  if (def.scope === "vault" && !access.can("vault.view", scope)) return false;
  return permissionsOf(def).every((p) => access.can(p, scope));
}

/**
 * The tools this caller can use through `target`, so `tools/list` never offers something that
 * would be refused. `visibleVaults` are the vaults the caller can see (used on `/mcp`).
 */
export function visibleTools(
  registry: ToolRegistry,
  access: RequestAccess,
  target: Target,
  visibleVaults: readonly string[],
  tier?: ToolTier,
  vault?: string,
): AnyTool[] {
  const inVault = target.endpoint === "vault" ? target.vault : vault;
  return registry.all(inVault).filter((def) => {
    if (tier && def.tier !== tier) return false;
    if (!onEndpoint(def, target.endpoint)) return false;
    if (def.scope === "server") return mayUse(access, def);
    if (inVault !== undefined) return mayUse(access, def, inVault);
    return visibleVaults.some((v) => mayUse(access, def, v));
  });
}

export function notFound(
  name: string,
  hint = "Use list_tools to see what is available.",
): AppError {
  return new AppError(
    "not_found",
    undefined,
    { tool: name },
    { message: `Unknown tool "${name}". ${hint}` },
  );
}
