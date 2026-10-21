import { Hono } from "hono";
import { AppError, errorHandler } from "./errors.ts";
import type { Logger } from "./log.ts";

export interface AppDeps {
  logger: Logger;
  version: string;
  /** False once shutdown has begun, so load balancers stop sending traffic. */
  ready: () => boolean;
  startedAt: number;
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

  return app;
}
