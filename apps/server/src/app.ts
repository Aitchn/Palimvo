import { Hono } from "hono";
import type { BackupService } from "./history/backup.ts";
import type { VaultHistory } from "./history/history.ts";
import { AppError, errorHandler } from "./errors.ts";
import type { Logger } from "./log.ts";
import { archiveRoutes } from "./routes/archive.ts";
import { fileRoutes } from "./routes/files.ts";
import { historyRoutes } from "./routes/history.ts";
import { searchRoutes } from "./routes/search.ts";
import type { VaultIndexes } from "./search/index.ts";
import { vaultRoutes } from "./routes/vaults.ts";
import { webRoutes } from "./web.ts";
import type { VaultService } from "./vault/service.ts";
import type { VaultTrash } from "./vault/trash.ts";

export interface AppDeps {
  logger: Logger;
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

  app.route("/", vaultRoutes(deps));
  app.route("/", fileRoutes(deps.vaults, deps.history));
  app.route("/", historyRoutes(deps));
  app.route("/", searchRoutes(deps.vaults, deps.indexes));
  app.route("/", archiveRoutes(deps.vaults));
  // Last: anything the API did not claim is a file of the web app or one of its routes.
  if (deps.webDir) app.route("/", webRoutes(deps.webDir));

  return app;
}
