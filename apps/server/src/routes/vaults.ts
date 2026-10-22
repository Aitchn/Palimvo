import { Hono } from "hono";
import { z } from "zod";
import type { VaultHistory } from "../history/history.ts";
import type { VaultService } from "../vault/service.ts";
import type { VaultTrash } from "../vault/trash.ts";
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
 * Guests see only vaults with public content; removing and creating vaults needs a server administrator
 * (see `accessGate`) until roles arrive in T52.
 */
export function vaultRoutes({ vaults, trash, history, auth }: VaultRouteDeps): Hono {
  const app = new Hono();

  app.get("/api/vaults", async (c) => {
    const all = await vaults.listVaults();
    if (principalOf(c).kind !== "guest") return c.json({ vaults: all });
    const visible = guestVaultIds(auth);
    return c.json({ vaults: all.filter((v) => visible.has(v.id)) });
  });

  app.post("/api/vaults", async (c) => {
    const { id } = await readJson(c, createBody);
    const created = await vaults.createVault(id);
    // The first commit is made now, so edits made right after are not folded into it.
    await history.ensureBaseline(id);
    return c.json(created, 201);
  });

  app.delete("/api/vaults/:vault", async (c) => {
    const id = c.req.param("vault");
    // Commit what is waiting first, so the removed folder holds the complete history.
    await history.commit(id).catch(() => undefined);
    return c.json(await trash.remove(id));
  });

  app.get("/api/removed-vaults", async (c) => c.json({ removed: await trash.list() }));

  app.post("/api/removed-vaults/:name/restore", async (c) =>
    c.json(await trash.restore(c.req.param("name"))),
  );

  return app;
}
