import type { Context } from "hono";
import type { z } from "zod";
import { AppError, isAppError, vaultScope } from "@palimvo/core";
import type { Author } from "@palimvo/core";
import { accessOf, type AccessControl } from "../auth/access.ts";
import { principalOf } from "../auth/principal.ts";
import { requestAuthor, requestNote } from "../routes/author.ts";
import type { VaultHistory } from "../history/history.ts";
import type { Logger } from "../log.ts";
import type { PluginManager } from "../plugins/manager.ts";
import type { ProposalService } from "../proposals/proposals.ts";
import type { VaultIndexes } from "../search/index.ts";
import type { Store } from "../store/index.ts";
import type { VaultService } from "../vault/service.ts";
import type { VaultTrash } from "../vault/trash.ts";
import {
  argumentsOf,
  REASON_ARG,
  mayUse,
  notFound,
  onEndpoint,
  permissionsOf,
  visibleTools,
  type AnyTool,
  type Endpoint,
  type Target,
  type ToolRegistry,
} from "./registry.ts";

/** What tool handlers receive as `ctx.deps`. Services are added here as the tools that need them arrive. */
export interface McpDeps {
  logger: Logger;
  store: Store;
  vaults: VaultService;
  history: VaultHistory;
  indexes: VaultIndexes;
  /** Where removed vaults go; `remove_vault` only moves a vault here. */
  trash: VaultTrash;
  /** Call after a change to who may do what (a new vault's administrator). */
  access: AccessControl;
  proposals: ProposalService;
  /** Which plugins are enabled in a vault; `list_vaults` shows them. Absent until the plugin platform exists. */
  plugins?: PluginCatalog;
  /** Installs, library and approvals; the plugin tools need it. */
  pluginManager?: PluginManager;
  [key: string]: unknown;
}

/** What the MCP tools need to know about plugins (the plugin platform supplies it). */
export interface PluginCatalog {
  enabled(vaultId: string): readonly { id: string; version?: string }[];
}

export interface Dispatcher {
  readonly target: Target;
  readonly endpoint: Endpoint;
  /** Tools to list in `tools/list`: native tools the caller can use here. */
  list(): Promise<AnyTool[]>;
  /** Advanced tools the caller can use, optionally in one vault (plugin tools need one). */
  advanced(vault?: string): Promise<AnyTool[]>;
  /** The tool, if the caller could run it. */
  describe(name: string, vault?: string): Promise<AnyTool | undefined>;
  /** Runs `name` as the caller; throws `AppError` when unknown, not allowed, or the arguments are wrong. */
  call(name: string, args: unknown): Promise<unknown>;
}

/** Entry tools run other tools; they cannot be run through each other. */
export const ENTRY_TOOLS: ReadonlySet<string> = new Set([
  "list_tools",
  "describe_tool",
  "call_tool",
]);

const MAX_ISSUES = 5;

function invalid(def: AnyTool, error: z.ZodError): AppError {
  const issues = error.issues.slice(0, MAX_ISSUES).map((i) => {
    const where = i.path.length > 0 ? i.path.join(".") : "(arguments)";
    return `${where}: ${i.message}`;
  });
  return new AppError(
    "invalid_request",
    undefined,
    { tool: def.name, issues },
    { message: `Invalid arguments for ${def.name}. ${issues.join("; ")}` },
  );
}

const errorCode = (err: unknown): string => (isAppError(err) ? err.code : "internal");

/** The single path every MCP call takes, whether it came from `tools/call` or `call_tool`. */
export function createDispatcher(opts: {
  c: Context;
  registry: ToolRegistry;
  deps: McpDeps;
  target: Target;
}): Dispatcher {
  const { c, registry, deps, target } = opts;
  const access = accessOf(c);
  const endpoint = target.endpoint;
  let visible: string[] | undefined;
  const visibleVaults = async (): Promise<string[]> => {
    if (target.endpoint === "vault") return [target.vault];
    visible ??= access.visibleVaults((await deps.vaults.listVaults()).map((v) => v.id));
    return visible;
  };

  /** Changes are audited whether they worked or not; reads are not (the history and logs cover them). */
  const audit = (
    def: AnyTool,
    vault: string,
    outcome: "ok" | "denied" | "failed",
    detail: Record<string, unknown>,
  ) => {
    const p = principalOf(c);
    if (p.kind !== "token") return;
    try {
      deps.store.audit.append({
        actorType: "token",
        actorId: p.bearer.sourceId,
        actorLabel: p.bearer.label,
        action: `mcp.${def.name}`,
        ...(vault ? { targetType: "vault", targetId: vault, vaultId: vault } : {}),
        detail: { outcome, ...detail },
      });
    } catch (err) {
      // An audit failure must not hide the result of a change that already happened.
      deps.logger.error("mcp audit failed", { tool: def.name, error: String(err) });
    }
  };

  const dispatcher: Dispatcher = {
    target,
    endpoint,
    async list() {
      await registry.prepare(target.endpoint === "vault" ? target.vault : undefined);
      return visibleTools(registry, access, target, await visibleVaults(), "native");
    },
    async advanced(vault) {
      await registry.prepare(target.endpoint === "vault" ? target.vault : vault);
      return visibleTools(registry, access, target, await visibleVaults(), "advanced", vault);
    },
    async describe(name, vault) {
      const inVault = target.endpoint === "vault" ? target.vault : vault;
      await registry.prepare(inVault);
      const def = registry.find(name, inVault);
      if (!def || !onEndpoint(def, endpoint)) return undefined;
      if (def.scope === "server") return mayUse(access, def) ? def : undefined;
      const vaults = inVault !== undefined ? [inVault] : await visibleVaults();
      return vaults.some((v) => mayUse(access, def, v)) ? def : undefined;
    },
    async call(name, rawArgs) {
      const raw = rawArgs ?? {};
      if (typeof raw !== "object" || Array.isArray(raw))
        throw new AppError("invalid_request", undefined, undefined, {
          message: "Tool arguments must be an object.",
        });
      const given = raw as Record<string, unknown>;
      // Plugin tools exist per vault, so the vault must be known before the tool can be found.
      if (given.vault !== undefined && typeof given.vault !== "string")
        throw new AppError("invalid_request", undefined, undefined, {
          message: "vault must be a string.",
        });
      if (target.endpoint === "vault" && given.vault !== undefined && given.vault !== target.vault)
        throw new AppError("token_scope_denied", undefined, undefined, {
          message: `This connection is for vault "${target.vault}"; use /mcp for several vaults.`,
        });
      const vaultArg = target.endpoint === "vault" ? target.vault : given.vault;
      if (typeof vaultArg === "string") await registry.prepare(vaultArg);

      const def = registry.find(name, vaultArg);
      if (!def || !onEndpoint(def, endpoint)) throw notFound(name);

      let vault = "";
      if (def.scope === "vault") {
        if (typeof vaultArg !== "string" || vaultArg === "")
          throw new AppError("invalid_request", undefined, undefined, {
            message: `${name} needs a "vault" argument. Call list_vaults to see them.`,
          });
        vault = vaultArg;
      }
      const writes = def.writes === true;
      const author: Author = requestAuthor(c);
      const fail = (err: unknown, outcome: "denied" | "failed"): never => {
        if (writes) audit(def, vault, outcome, { author: author.name, error: errorCode(err) });
        throw err;
      };

      // Permission first: someone without access should not learn what the arguments look like.
      try {
        if (def.adminGrant && !access.adminGrant)
          throw new AppError("forbidden", undefined, undefined, {
            message: `${name} is only available to an OAuth connection the person allowed to administer. API tokens cannot use it.`,
          });
        if (def.scope === "vault") access.requireVault("vault.view", vault);
        for (const p of permissionsOf(def))
          if (def.scope === "server") access.requireServer(p);
          else if (def.adminGrant) access.requirePerson(p, vaultScope(vault));
          else access.requireVault(p, vault);
      } catch (err) {
        return fail(err, "denied");
      }
      // A header reason must pass the same rules as the argument (not blank, at most 300 characters).
      const rawHeader = requestNote(c).reason;
      const headerReason =
        rawHeader === undefined ? undefined : REASON_ARG.safeParse(rawHeader).data;
      const parsed = argumentsOf(def, endpoint, headerReason !== undefined).safeParse(given);
      if (!parsed.success) return fail(invalid(def, parsed.error), "failed");
      const args = parsed.data as Record<string, unknown>;
      const reason = typeof args.reason === "string" ? args.reason : headerReason;
      delete args.reason;
      // Server-wide tools may take their own `vault` (the entry tools do); only the registry's is consumed.
      if (def.scope === "vault") delete args.vault;

      try {
        const result = await def.handler(args, {
          deps,
          access,
          author,
          note: { reason },
          vault,
          endpoint,
          dispatcher,
          request: c,
        });
        if (writes) audit(def, vault, "ok", { author: author.name, reason });
        return result;
      } catch (err) {
        return fail(err, "failed");
      }
    },
  };
  return dispatcher;
}
