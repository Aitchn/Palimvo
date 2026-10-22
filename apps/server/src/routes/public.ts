import { Hono } from "hono";
import { AppError, InvalidPathError, normalizeVaultPath } from "@palimvo/core";
import { z } from "zod";
import { principalOf, requireAccount } from "../auth/principal.ts";
import { isHiddenPath } from "../auth/publicPolicy.ts";
import type { AuthService } from "../auth/service.ts";
import type { VaultService } from "../vault/service.ts";
import { readJson } from "./util.ts";

const putBody = z.object({ paths: z.array(z.string().max(1000)).max(500) });

/**
 * What guests may read: `GET|PUT /api/vaults/:vault/public`. Allowed for server administrators and
 * the vault's administrators; the `public.manage` permission takes over in T52.
 */
export function publicRoutes(auth: AuthService, vaults: VaultService): Hono {
  const app = new Hono();

  const canManage = (c: Parameters<typeof principalOf>[0], vault: string): void => {
    const p = principalOf(c);
    if (p.kind === "open") return;
    const { account } = requireAccount(c);
    if (account.serverAdmin) return;
    if (auth.store.accounts.getMember(vault, account.id)?.position === "admin") return;
    throw new AppError("forbidden");
  };

  app.get("/api/vaults/:vault/public", async (c) => {
    const vault = c.req.param("vault");
    await vaults.assertVault(vault);
    canManage(c, vault);
    return c.json({ paths: auth.store.publicAccess.list(vault) });
  });

  app.put("/api/vaults/:vault/public", async (c) => {
    const vault = c.req.param("vault");
    await vaults.assertVault(vault);
    canManage(c, vault);
    const { paths } = await readJson(c, putBody);
    const cleaned = paths.map((raw) => {
      // "" (or "/") is the whole vault.
      if (raw === "" || raw === "/") return "";
      let p: string;
      try {
        p = normalizeVaultPath(raw);
      } catch (err) {
        if (err instanceof InvalidPathError)
          throw new AppError("invalid_path", undefined, { path: raw });
        throw err;
      }
      if (isHiddenPath(p)) throw new AppError("invalid_path", undefined, { path: raw });
      return p;
    });
    auth.store.publicAccess.replace(vault, cleaned);
    const p = principalOf(c);
    auth.store.audit.append({
      actorType: p.kind === "account" ? "account" : "system",
      ...(p.kind === "account" ? { actorId: p.account.id, actorLabel: p.account.username } : {}),
      action: "vault.public_changed",
      vaultId: vault,
      detail: { paths: cleaned },
    });
    return c.json({ paths: auth.store.publicAccess.list(vault) });
  });

  return app;
}
