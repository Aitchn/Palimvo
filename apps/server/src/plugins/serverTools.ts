import { z } from "zod";
import { AppError } from "@palimvo/core";
import type { PluginManifest, ToolContribution } from "@palimvo/plugin-sdk";
import type { Logger } from "../log.ts";
import type { AnyTool, ToolProvider } from "../mcp/registry.ts";
import type { Ctx } from "../mcp/tools/shared.ts";
import { createHostApi } from "./hostApi.ts";
import type { PluginManager } from "./manager.ts";
import { SandboxError, type SandboxPool } from "./sandbox/index.ts";
import type { PluginToolSettingsStore } from "./toolSettings.ts";

export interface PluginToolProviderDeps {
  manager: Pick<PluginManager, "list" | "load">;
  pool: Pick<SandboxPool, "run">;
  settings?: PluginToolSettingsStore;
  logger: Logger;
}

/** `<plugin-id>.<tool>`: what AI clients call a plugin's tool. */
export const pluginToolName = (pluginId: string, tool: string): string => `${pluginId}.${tool}`;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z][a-z0-9_]{0,63}$/;

/** Compiled argument checkers, by plugin hash and tool: a changed plugin has a new hash. */
const MAX_COMPILED = 500;

/**
 * Turns the tools of the plugins running in a vault into MCP tools. They are always advanced
 * (found with `list_tools`, run with `call_tool`), exist only in vaults where the plugin runs,
 * and execute in the QuickJS sandbox with a host API limited to what the manifest declares and
 * the caller may do. A vault can additionally list them in `tools/list` of `/mcp/<vault>`.
 */
export class PluginToolProvider implements ToolProvider {
  private readonly compiled = new Map<string, z.ZodType | null>();

  constructor(private readonly deps: PluginToolProviderDeps) {}

  async prepare(vaultId: string): Promise<void> {
    await this.deps.settings?.load(vaultId);
  }

  toolsFor(vaultId: string): readonly AnyTool[] {
    const listed = this.deps.settings?.cached(vaultId).listed === true;
    const tools: AnyTool[] = [];
    for (const plugin of this.deps.manager.list(vaultId)) {
      if (plugin.state !== "running") continue;
      const { manifest } = plugin;
      if (!manifest.server) continue;
      for (const tool of manifest.contributes.tools) {
        const def = this.define(vaultId, plugin.sha256, manifest, tool, listed);
        if (def) tools.push(def);
      }
    }
    return tools;
  }

  private checker(sha256: string, tool: ToolContribution): z.ZodType | null {
    const key = `${sha256}\0${tool.name}`;
    const known = this.compiled.get(key);
    if (known !== undefined) return known;
    let checker: z.ZodType | null;
    try {
      checker = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (err) {
      this.deps.logger.warn("plugin tool schema cannot be checked; the tool is not offered", {
        tool: tool.name,
        error: String(err),
      });
      checker = null;
    }
    if (this.compiled.size >= MAX_COMPILED) this.compiled.clear();
    this.compiled.set(key, checker);
    return checker;
  }

  private define(
    vault: string,
    sha256: string,
    manifest: PluginManifest,
    tool: ToolContribution,
    listed: boolean,
  ): AnyTool | null {
    const name = pluginToolName(manifest.id, tool.name);
    if (!NAME.test(name)) return null;
    const checker = this.checker(sha256, tool);
    if (!checker) return null;
    const readOnly = tool.readOnly === true;
    return {
      name,
      // The registry makes provider tools advanced whatever they claim; `listedOn` is the vault's opt-in.
      tier: "advanced",
      scope: "vault",
      // The plugin's own reads and writes are checked per path against its manifest and the caller.
      permission: "note.read",
      input: z.looseObject({}),
      argumentSchema: tool.inputSchema,
      description: tool.description,
      writes: !readOnly,
      ...(listed ? { listedOn: ["vault"] as const } : {}),
      handler: (args, ctx: Ctx) => this.run(manifest.id, tool.name, checker, args, ctx),
    };
  }

  private async run(
    pluginId: string,
    toolName: string,
    checker: z.ZodType,
    args: unknown,
    ctx: Ctx,
  ): Promise<unknown> {
    const full = pluginToolName(pluginId, toolName);
    const parsed = checker.safeParse(args);
    if (!parsed.success)
      throw new AppError(
        "invalid_request",
        undefined,
        { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
        {
          message: `Invalid arguments for ${full}: ${parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        },
      );
    // `load` re-hashes the files: what runs is exactly what a person approved.
    const { plugin, files } = await this.deps.manager.load(ctx.vault, pluginId);
    const entry = plugin.manifest.server;
    const bytes = files.find((f) => f.path === entry)?.bytes;
    if (!bytes)
      throw new AppError("plugin_invalid", undefined, undefined, {
        message: `"${pluginId}" has no server file "${entry ?? ""}".`,
      });
    if (!plugin.manifest.contributes.tools.some((t) => t.name === toolName))
      throw new AppError("not_found", undefined, { tool: full });
    try {
      const out = await this.deps.pool.run(
        new TextDecoder().decode(bytes),
        toolName,
        parsed.data,
        createHostApi(ctx, plugin.manifest),
      );
      return { result: out.result, ...(out.logs.length > 0 ? { logs: out.logs } : {}) };
    } catch (err) {
      throw toAppError(err, full);
    }
  }
}

/** What an AI client is told when a plugin tool fails. */
export function toAppError(err: unknown, tool: string): AppError {
  if (!(err instanceof SandboxError)) throw err;
  const details = { tool, kind: err.kind };
  switch (err.kind) {
    case "timeout":
      return new AppError("unavailable", undefined, details, {
        message: `${tool} took too long and was stopped.`,
      });
    case "memory":
      return new AppError("unavailable", undefined, details, {
        message: `${tool} used too much memory and was stopped.`,
      });
    case "busy":
      return new AppError("rate_limited", undefined, details, { message: err.message });
    case "result-too-large":
      return new AppError("payload_too_large", undefined, details, {
        message: `${tool} returned more than 1 MiB.`,
      });
    case "load":
      return new AppError("internal", undefined, details, {
        message: `${tool} could not start: ${err.message}`,
      });
    default:
      return new AppError("internal", undefined, details, {
        message: `${tool} failed: ${err.message}`,
      });
  }
}
