import { z } from "zod";
import { mcpTool } from "./shared.ts";
import { vaultScope } from "@palimvo/core";

/** What the caller may do in a vault, in the words an AI needs to pick its tools. */
export const accessLevel = (
  can: (name: "note.write" | "proposal.create") => boolean,
): "write" | "propose" | "read" =>
  can("note.write") ? "write" : can("proposal.create") ? "propose" : "read";

export const listVaults = mcpTool({
  name: "list_vaults",
  tier: "native",
  scope: "server",
  permission: [],
  endpoints: ["all"],
  input: z.object({}),
  description:
    "The vaults this connection can use, with what you may do in each (read, propose or write) and the plugins enabled there (their tools are behind list_tools). Pass a vault id as `vault` to the other tools.",
  handler: async (_args, ctx) => {
    const { vaults, plugins } = ctx.deps;
    const ids = ctx.access.visibleVaults((await vaults.listVaults()).map((v) => v.id));
    return {
      vaults: ids.map((id) => {
        const enabled = plugins?.enabled(id) ?? [];
        return {
          id,
          access: accessLevel((n) => ctx.access.can(n, vaultScope(id))),
          ...(enabled.length > 0 ? { plugins: enabled } : {}),
        };
      }),
    };
  },
});
