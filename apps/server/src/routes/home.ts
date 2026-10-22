import { Hono } from "hono";
import { ACTIVITY_FILTERS, AppError, type ActivityFilter, type HomeConfig } from "@palimvo/core";
import { accessOf } from "../auth/access.ts";
import { guestPolicy } from "../auth/principal.ts";
import type { AuthService } from "../auth/service.ts";
import { homePutSchema, type HomeService } from "../home/home.ts";
import type { VaultService } from "../vault/service.ts";
import { requestAuthor, requestNote } from "./author.ts";
import { auditCall, readJson } from "./util.ts";

const DEFAULT_ACTIVITY_LIMIT = 30;

/**
 * A vault's home page: `GET|PUT /api/vaults/:vault/home` and `GET …/home/activity`.
 * Anyone who can see the vault reads the settings; guests get only the public parts of them.
 * Changing them needs `vault.settings`; the activity wall needs `history.view`.
 */
export function homeRoutes(vaults: VaultService, home: HomeService, auth: AuthService): Hono {
  const app = new Hono();

  app.get("/api/vaults/:vault/home", async (c) => {
    const vault = c.req.param("vault")!;
    accessOf(c).requireVault("vault.view", vault);
    await vaults.assertVault(vault);
    const state = await home.get(vault);
    const policy = guestPolicy(auth, c, vault);
    if (!policy) return c.json(state);
    // Guests see what is public: the pinned notes and databases they may read, and the intro note.
    const config: HomeConfig = {
      ...state.config,
      widgets: state.config.widgets.filter(
        (w) => w.type === "pinned" || (w.type === "base" && policy.covers(w.path)),
      ),
      pinned: state.config.pinned.filter((p) => policy.covers(p)),
      publicNote:
        state.config.publicNote !== null && policy.covers(state.config.publicNote)
          ? state.config.publicNote
          : null,
    };
    return c.json({ config, version: null });
  });

  app.put("/api/vaults/:vault/home", async (c) => {
    const vault = c.req.param("vault")!;
    accessOf(c).requireVault("vault.settings", vault);
    await vaults.assertVault(vault);
    const input = await readJson(c, homePutSchema);
    const saved = await home.put(vault, input, requestAuthor(c), requestNote(c));
    auditCall(auth, c, "vault.home_changed", { vaultId: vault });
    return c.json(saved);
  });

  app.get("/api/vaults/:vault/home/activity", async (c) => {
    const vault = c.req.param("vault")!;
    accessOf(c).requireVault("history.view", vault);
    await vaults.assertVault(vault);
    const filter = (c.req.query("filter") ?? "all") as ActivityFilter;
    if (!ACTIVITY_FILTERS.includes(filter)) {
      throw new AppError("invalid_request", undefined, { field: "filter" });
    }
    const limit = Number(c.req.query("limit") ?? DEFAULT_ACTIVITY_LIMIT);
    return c.json(
      await home.activity(vault, filter, Number.isFinite(limit) ? limit : DEFAULT_ACTIVITY_LIMIT),
    );
  });

  return app;
}
