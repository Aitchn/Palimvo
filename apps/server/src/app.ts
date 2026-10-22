import { Hono } from "hono";
import { accessGate, principalMiddleware } from "./auth/principal.ts";
import type { AuthService } from "./auth/service.ts";
import type { BackupService } from "./history/backup.ts";
import type { VaultHistory } from "./history/history.ts";
import { AppError, errorHandler } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { Store } from "./store/index.ts";
import { setupRoutes } from "./routes/setup.ts";
import type { SetupService } from "./auth/setup.ts";
import { adminRoutes } from "./routes/admin.ts";
import { archiveRoutes } from "./routes/archive.ts";
import { authRoutes } from "./routes/auth.ts";
import { memberRoutes } from "./routes/members.ts";
import { roleRoutes } from "./routes/roles.ts";
import { fileRoutes } from "./routes/files.ts";
import { historyRoutes } from "./routes/history.ts";
import { publicRoutes } from "./routes/public.ts";
import { searchRoutes } from "./routes/search.ts";
import type { VaultIndexes } from "./search/index.ts";
import { vaultRoutes } from "./routes/vaults.ts";
import { webRoutes } from "./web.ts";
import type { VaultService } from "./vault/service.ts";
import type { VaultTrash } from "./vault/trash.ts";

export interface AppDeps {
  logger: Logger;
  store: Store;
  auth: AuthService;
  setup: SetupService;
  /** Keep the API open until the first account exists (development only). */
  devInsecure?: boolean;
  /** Externally visible origin; decides the cookie's `Secure` flag and invite links. */
  publicUrl?: string | undefined;
  trustProxy?: boolean;
  version: string;
  /** False once shutdown has begun, so load balancers stop sending traffic. */
  ready: () => boolean;
  startedAt: number;
  vaults: VaultService;
  trash: VaultTrash;
  history: VaultHistory;
  indexes: VaultIndexes;
  backup: BackupService;
  /** Folder with the built web app; leave out to serve the API only. */
  webDir?: string;
}

/** Builds the HTTP application. Domain routers are mounted here as they are added. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.onError(errorHandler(deps.logger));
  app.notFound(() => {
    throw new AppError("not_found", 404, "Not found");
  });

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    if (c.req.path === "/api/health") return;
    deps.logger.info("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    });
  });

  app.get("/api/health", (c) => {
    const ready = deps.ready();
    return c.json(
      {
        status: ready ? "ok" : "shutting_down",
        version: deps.version,
        uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      },
      ready ? 200 : 503,
    );
  });

  app.use(
    "/api/*",
    principalMiddleware({
      auth: deps.auth,
      publicUrl: deps.publicUrl,
      devInsecure: deps.devInsecure ?? false,
    }),
  );
  app.use("/api/*", accessGate());
  app.route(
    "/",
    setupRoutes({
      auth: deps.auth,
      setup: deps.setup,
      vaults: deps.vaults,
      history: deps.history,
      trash: deps.trash,
      publicUrl: deps.publicUrl,
      trustProxy: deps.trustProxy ?? false,
    }),
  );
  app.route(
    "/",
    authRoutes({
      auth: deps.auth,
      publicUrl: deps.publicUrl,
      trustProxy: deps.trustProxy ?? false,
    }),
  );
  app.route("/", adminRoutes({ auth: deps.auth, vaults: deps.vaults, publicUrl: deps.publicUrl }));
  app.route("/", roleRoutes(deps.auth));
  app.route("/", memberRoutes(deps.auth, deps.vaults));
  app.route("/", publicRoutes(deps.auth, deps.vaults));
  app.route("/", vaultRoutes(deps));
  app.route("/", fileRoutes(deps.vaults, deps.history, deps.auth));
  app.route("/", historyRoutes(deps));
  app.route("/", searchRoutes(deps.vaults, deps.indexes, deps.auth));
  app.route("/", archiveRoutes(deps.vaults));
  // Last: anything the API did not claim is a file of the web app or one of its routes.
  if (deps.webDir) app.route("/", webRoutes(deps.webDir));

  return app;
}
