import { Hono } from "hono";
import { z } from "zod";
import { requestIsLocal } from "../auth/setup.ts";
import { clientIp, checkOrigin, setSessionCookie } from "../auth/principal.ts";
import { publicAccount, type AuthService } from "../auth/service.ts";
import type { SetupService } from "../auth/setup.ts";
import type { VaultHistory } from "../history/history.ts";
import type { VaultTrash } from "../vault/trash.ts";
import { SAMPLE_FILES } from "../vault/sample.ts";
import type { VaultService } from "../vault/service.ts";
import { readJson } from "./util.ts";

export interface SetupRouteDeps {
  auth: AuthService;
  setup: SetupService;
  vaults: VaultService;
  history: VaultHistory;
  trash: VaultTrash;
  publicUrl?: string | undefined;
  trustProxy: boolean;
}

const setupBody = z.object({
  code: z.string().max(100).optional(),
  username: z.string().max(100),
  password: z.string().max(1000),
  displayName: z.string().max(80).optional(),
  vault: z
    .object({ id: z.string().max(100).default("main"), sample: z.boolean().default(false) })
    .default({ id: "main", sample: false }),
});

/** First-time setup: `GET /api/setup/status` and `POST /api/setup`. */
export function setupRoutes({
  auth,
  setup,
  vaults,
  history,
  trash,
  publicUrl,
  trustProxy,
}: SetupRouteDeps): Hono {
  const app = new Hono();
  const secure = publicUrl?.startsWith("https://") ?? false;

  app.get("/api/setup/status", (c) =>
    c.json({
      required: !setup.complete,
      needsCode: setup.needsCode(requestIsLocal(c)),
    }),
  );

  app.post("/api/setup", async (c) => {
    checkOrigin(c, publicUrl);
    const body = await readJson(c, setupBody);
    const ua = c.req.header("user-agent");
    const result = await setup.finish(
      {
        username: body.username,
        password: body.password,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        vault: body.vault.id,
        sample: body.vault.sample,
      },
      {
        local: requestIsLocal(c),
        ip: clientIp(c, trustProxy),
        ...(body.code ? { code: body.code } : {}),
      },
      async (id, sample) => {
        await vaults.createVault(id);
        if (sample) for (const f of SAMPLE_FILES) await vaults.writeFile(id, f.path, f.content);
        // The first commit is made now, so edits made right after are not folded into it.
        await history.ensureBaseline(id);
      },
      async (id) => {
        await trash.remove(id);
      },
    );
    const signed = auth.openSession(result.account, ua);
    setSessionCookie(c, signed.cookie, { secure });
    return c.json(
      {
        account: publicAccount(signed.account),
        csrfToken: auth.csrfToken(signed.cookie),
        vault: result.vault,
      },
      201,
    );
  });

  return app;
}
