import { z } from "zod";
import { vaultScope } from "@palimvo/core";
import type { McpDeps } from "../dispatch.ts";
import { defineTool } from "../registry.ts";

/** What the caller may do in a vault, in the words an AI needs to pick its tools. */
export const accessLevel = (
  can: (name: "note.write" | "proposal.create") => boolean,
): "write" | "propose" | "read" =>
  can("note.write") ? "write" : can("proposal.create") ? "propose" : "read";

export const listVaults = defineTool<z.ZodObject, McpDeps>({
  name: "list_vaults",
  tier: "native",
  scope: "server",
  permission: [],
  endpoints: ["all"],
  input: z.object({}),
  description:
    "The vaults this connection can use, with what you may do in each (read, propose or write). Pass one as `vault` to the other tools.",
  handler: async (_args, ctx) => {
    const { vaults } = ctx.deps;
    const ids = ctx.access.visibleVaults((await vaults.listVaults()).map((v) => v.id));
    return {
      vaults: ids.map((id) => ({
        id,
        access: accessLevel((n) => ctx.access.can(n, vaultScope(id))),
      })),
    };
  },
});
