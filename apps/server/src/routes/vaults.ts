import { Hono } from "hono";
import { z } from "zod";
import type { VaultHistory } from "../history/history.ts";
import type { VaultService } from "../vault/service.ts";
import type { VaultTrash } from "../vault/trash.ts";
import { accessOf } from "../auth/access.ts";
import { guestVaultIds, principalOf } from "../auth/principal.ts";
import type { AuthService } from "../auth/service.ts";
import { readJson } from "./util.ts";

export interface VaultRouteDeps {
  vaults: VaultService;
  trash: VaultTrash;
  history: VaultHistory;
  auth: AuthService;
}

const createBody = z.object({ id: z.string() });

/**
 * Listing, creating, removing and restoring whole vaults.
 * People see the vaults they may view (members, or everything for server administrators); guests
 * see only vaults with public content. Creating a vault needs `vaults.create` and makes the
 * creator its administrator; removing and restoring vaults needs `server.manage`.
 */
export function vaultRoutes({ vaults, trash, history, auth }: VaultRouteDeps): Hono {
  const app = new Hono();

  app.get("/api/vaults", async (c) => {
    const all = await vaults.listVaults();
    const access = accessOf(c);
    if (access.isGuest) {
      const visible = guestVaultIds(auth);
      return c.json({ vaults: all.filter((v) => visible.has(v.id)) });
    }
    const seen = new Set(access.visibleVaults(all.map((v) => v.id)));
    return c.json({ vaults: all.filter((v) => seen.has(v.id)) });
  });

  app.post("/api/vaults", async (c) => {
    accessOf(c).requireServer("vaults.create");
    const { id } = await readJson(c, createBody);
    const created = await vaults.createVault(id);
    const p = principalOf(c);
    // A new vault starts clean: members, overrides or tokens left by an earlier vault of this id must not carry over.
    auth.store.tx(() => {
      auth.store.accounts.deleteVaultData(id);
      if (p.kind === "account") auth.store.joinVault(id, p.account.id, "admin");
    });
    auth.access.invalidate();
    if (p.kind === "account") {
      auth.store.audit.append({
        actorType: "account",
        actorId: p.account.id,
        actorLabel: p.account.username,
        action: "vault.created",
        vaultId: id,
      });
    }
    // The first commit is made now, so edits made right after are not folded into it.
    await history.ensureBaseline(id);
    return c.json(created, 201);
  });

  app.delete("/api/vaults/:vault", async (c) => {
    accessOf(c).requireServer("server.manage");
    const id = c.req.param("vault");
    // Commit what is waiting first, so the removed folder holds the complete history.
    await history.commit(id).catch(() => undefined);
    return c.json(await trash.remove(id));
  });

  app.get("/api/removed-vaults", async (c) => {
    accessOf(c).requireServer("server.manage");
    return c.json({ removed: await trash.list() });
  });

  app.post("/api/removed-vaults/:name/restore", async (c) => {
    accessOf(c).requireServer("server.manage");
    return c.json(await trash.restore(c.req.param("name")));
  });

  return app;
}
