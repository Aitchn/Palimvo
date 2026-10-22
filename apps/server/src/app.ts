import { Hono } from "hono";
import { bearerMiddleware } from "./auth/bearer.ts";
import { coreTools } from "./mcp/tools/index.ts";
import { mcpCors, mcpRoutes } from "./mcp/server.ts";
import type { PluginCatalog } from "./mcp/dispatch.ts";
import { ToolRegistry, type AnyTool, type ToolProvider } from "./mcp/registry.ts";
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
import { oauthRoutes } from "./routes/oauth.ts";
import { tokenRoutes } from "./routes/tokens.ts";
import { memberRoutes } from "./routes/members.ts";
import { roleRoutes } from "./routes/roles.ts";
import { fileRoutes } from "./routes/files.ts";
import { historyRoutes } from "./routes/history.ts";
import { proposalRoutes } from "./routes/proposals.ts";
import { ProposalService } from "./proposals/proposals.ts";
import { publicRoutes } from "./routes/public.ts";
import { baseRoutes } from "./routes/bases.ts";
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
  /** Extra MCP tools per vault (plugins); they appear behind `list_tools`. */
  toolProviders?: ToolProvider[];
  /** Extra core MCP tools beyond the built-in ones. */
  mcpTools?: AnyTool[];
  /** Which plugins are enabled per vault, for `list_vaults`. */
  plugins?: PluginCatalog;
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
  app.route("/", tokenRoutes({ auth: deps.auth, tokens: deps.auth.tokens, vaults: deps.vaults }));
  app.route("/", memberRoutes(deps.auth, deps.vaults));
  app.route("/", publicRoutes(deps.auth, deps.vaults));
  app.route("/", vaultRoutes(deps));
  app.route("/", fileRoutes(deps.vaults, deps.history, deps.auth));
  const proposals = new ProposalService({ vaults: deps.vaults, history: deps.history });
  app.route("/", historyRoutes(deps));
  app.route("/", proposalRoutes(deps.vaults, proposals, deps.auth));
  app.route("/", searchRoutes(deps.vaults, deps.indexes, deps.auth));
  app.route("/", baseRoutes(deps.vaults, deps.history, deps.auth));
  app.route("/", archiveRoutes(deps.vaults));
  app.route(
    "/",
    oauthRoutes({
      auth: deps.auth,
      oauth: deps.auth.oauth,
      vaults: deps.vaults,
      publicUrl: deps.publicUrl,
      trustProxy: deps.trustProxy ?? false,
    }),
  );
  // AI calls: bearer secrets only, never the browser session.
  const mcpGate = bearerMiddleware({
    auth: deps.auth,
    tokens: deps.auth.tokens,
    publicUrl: deps.publicUrl,
  });
  const registry = new ToolRegistry([...coreTools(), ...(deps.mcpTools ?? [])]);
  for (const provider of deps.toolProviders ?? []) registry.addProvider(provider);
  // "/mcp/*" also matches "/mcp"; registering both would run the gate (and count the rate limit) twice.
  app.use("/mcp/*", mcpCors);
  app.use("/mcp/*", mcpGate);
  app.route(
    "/",
    mcpRoutes({
      deps: {
        logger: deps.logger,
        store: deps.store,
        vaults: deps.vaults,
        history: deps.history,
        indexes: deps.indexes,
        trash: deps.trash,
        access: deps.auth.access,
        proposals,
        ...(deps.plugins ? { plugins: deps.plugins } : {}),
      },
      registry,
      version: deps.version,
    }),
  );
  // Last: anything the API did not claim is a file of the web app or one of its routes.
  if (deps.webDir) app.route("/", webRoutes(deps.webDir));

  return app;
}
