import { Hono } from "hono";
import { z } from "zod";
import type { VaultService } from "../vault/service.ts";
import type { VaultTrash } from "../vault/trash.ts";
import { readJson } from "./util.ts";

export interface VaultRouteDeps {
  vaults: VaultService;
  trash: VaultTrash;
}

const createBody = z.object({ id: z.string() });

/**
 * Listing, creating, removing and restoring whole vaults.
 * Access control arrives with accounts (T10); until then the server only listens on loopback by default.
 */
export function vaultRoutes({ vaults, trash }: VaultRouteDeps): Hono {
  const app = new Hono();

  app.get("/api/vaults", async (c) => c.json({ vaults: await vaults.listVaults() }));

  app.post("/api/vaults", async (c) => {
    const { id } = await readJson(c, createBody);
    return c.json(await vaults.createVault(id), 201);
  });

  app.delete("/api/vaults/:vault", async (c) => c.json(await trash.remove(c.req.param("vault"))));

  app.get("/api/removed-vaults", async (c) => c.json({ removed: await trash.list() }));

  app.post("/api/removed-vaults/:name/restore", async (c) =>
    c.json(await trash.restore(c.req.param("name"))),
  );

  return app;
}
