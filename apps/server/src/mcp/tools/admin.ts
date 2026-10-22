import { z } from "zod";
import { AppError, isValidVaultId } from "@palimvo/core";
import { principalOf } from "../../auth/principal.ts";
import { invalid, mcpTool, type Ctx } from "./shared.ts";

/** Records who did it in the audit log, next to the generic `mcp.<tool>` line. */
function audit(ctx: Ctx, action: string, vaultId: string): void {
  const p = principalOf(ctx.request);
  if (p.kind !== "token") return;
  ctx.deps.store.audit.append({
    actorType: "token",
    actorId: p.bearer.sourceId,
    actorLabel: p.bearer.label,
    action,
    targetType: "vault",
    targetId: vaultId,
    vaultId,
    detail: { account: p.account.id, author: ctx.author.name, reason: ctx.note.reason },
  });
}

export const createVault = mcpTool({
  name: "create_vault",
  tier: "advanced",
  scope: "server",
  permission: "vaults.create",
  adminGrant: true,
  endpoints: ["all"],
  writes: true,
  input: z.object({
    id: z
      .string()
      .min(1)
      .describe("Short name for the vault: letters, digits, `-` and `_`, e.g. `team-notes`."),
  }),
  description:
    "Create a new vault. The person you act for becomes its administrator. Only for connections the person allowed to administer. Example: {id:'team-notes', reason:'Notes for the new team'}.",
  handler: async (args, ctx) => {
    const { vaults, store, history, access } = ctx.deps;
    if (!isValidVaultId(args.id)) throw invalid(`Invalid vault id "${args.id}".`);
    const accountId = ctx.access.accountId;
    if (!accountId) throw new AppError("forbidden");
    const created = await vaults.createVault(args.id);
    // A new vault starts clean: members, overrides or tokens left by an earlier vault of this id must not carry over.
    store.tx(() => {
      store.accounts.deleteVaultData(args.id);
      store.joinVault(args.id, accountId, "admin");
    });
    access.invalidate();
    audit(ctx, "vault.created", args.id);
    await history.ensureBaseline(args.id);
    return created;
  },
});

export const removeVault = mcpTool({
  name: "remove_vault",
  tier: "advanced",
  scope: "vault",
  permission: "vault.settings",
  adminGrant: true,
  endpoints: ["all"],
  writes: true,
  destructive: true,
  input: z.object({
    confirm: z.string().min(1).describe("The vault's id again, to confirm."),
  }),
  description:
    "Move a vault to the server's trash: it disappears for everyone, but its files and history are kept and an administrator can restore it in the web app. Only for connections the person allowed to administer. Example: {vault:'old-notes', confirm:'old-notes', reason:'Merged into team-notes'}.",
  handler: async (args, ctx) => {
    if (args.confirm !== ctx.vault)
      throw invalid(`confirm must repeat the vault id "${ctx.vault}" exactly.`);
    const { history, trash } = ctx.deps;
    // Commit what is waiting first, so the removed folder holds the complete history.
    await history.commit(ctx.vault).catch(() => undefined);
    const removed = await trash.remove(ctx.vault);
    audit(ctx, "vault.removed", ctx.vault);
    return {
      removed: ctx.vault,
      kept_as: removed.name,
      restore: "An administrator can restore it in the web app.",
    };
  },
});
