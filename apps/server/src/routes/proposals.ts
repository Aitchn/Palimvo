import { Hono, type Context } from "hono";
import { AppError, vaultScope } from "@palimvo/core";
import { accessOf } from "../auth/access.ts";
import type { AuthService } from "../auth/service.ts";
import {
  proposalInputSchema,
  proposalReviewSchema,
  type ProposalService,
} from "../proposals/proposals.ts";
import type { VaultService } from "../vault/service.ts";
import { requestAuthor } from "./author.ts";
import { auditCall, readJson } from "./util.ts";

/**
 * Edit proposals: `/api/vaults/:vault/proposals`. Anyone who may propose can read the list; only
 * a signed-in person who holds `proposal.review` on a file's folder can accept or reject changes
 * to it, so an AI token can never approve its own (or anyone's) proposal.
 */
export function proposalRoutes(
  vaults: VaultService,
  proposals: ProposalService,
  auth: AuthService,
): Hono {
  const app = new Hono();

  /** Proposals can quote private notes: only people who may propose or review get to see them. */
  const mayList = async (c: Context): Promise<string> => {
    const vault = c.req.param("vault")!;
    const access = accessOf(c);
    access.requireVault("vault.view", vault);
    const scope = vaultScope(vault);
    if (!access.can("proposal.create", scope) && !access.can("proposal.review", scope)) {
      access.requireVault("proposal.create", vault);
    }
    await vaults.assertVault(vault);
    return vault;
  };

  app.get("/api/vaults/:vault/proposals", async (c) => {
    const vault = await mayList(c);
    return c.json({
      proposals: await proposals.list(vault, { open: c.req.query("state") !== "all" }),
    });
  });

  app.get("/api/vaults/:vault/proposals/:id", async (c) => {
    const vault = await mayList(c);
    return c.json(await proposals.get(vault, c.req.param("id")));
  });

  app.post("/api/vaults/:vault/proposals", async (c) => {
    const vault = c.req.param("vault")!;
    accessOf(c).requireVault("proposal.create", vault);
    await vaults.assertVault(vault);
    const body = await readJson(c, proposalInputSchema);
    const created = await proposals.create(vault, body, requestAuthor(c));
    auditCall(auth, c, "proposal.create", {
      vaultId: vault,
      targetType: "proposal",
      targetId: created.id,
      detail: { files: created.files.map((f) => f.path) },
    });
    return c.json(created, 201);
  });

  for (const action of ["accept", "reject"] as const) {
    app.post(`/api/vaults/:vault/proposals/:id/${action}`, async (c) => {
      const vault = c.req.param("vault")!;
      const access = accessOf(c);
      access.requireVault("vault.view", vault);
      // Deciding is a person's call, whatever an AI token's owner may do.
      if (access.bearer) throw new AppError("forbidden");
      await vaults.assertVault(vault);
      const input = await readJson(c, proposalReviewSchema);
      const current = await proposals.get(vault, c.req.param("id"));
      const chosen = new Set(input.hunkIds ?? []);
      // Each file the decision touches needs the right in its own folder (a folder may deny it).
      for (const file of current.files) {
        const touched = file.hunks.some((h) =>
          input.hunkIds ? chosen.has(h.id) : h.state === "pending",
        );
        if (touched) access.requireTree("proposal.review", vault, file.path);
      }
      const decided = await proposals.review(vault, current.id, input, action, requestAuthor(c));
      auditCall(auth, c, `proposal.${action}`, {
        vaultId: vault,
        targetType: "proposal",
        targetId: decided.id,
        detail: { hunks: input.hunkIds?.length ?? "all" },
      });
      return c.json(decided);
    });
  }

  return app;
}
