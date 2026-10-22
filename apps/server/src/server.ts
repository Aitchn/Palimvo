import type { Server } from "node:http";
import path from "node:path";
import { serve } from "@hono/node-server";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.ts";
import { AuthService } from "./auth/service.ts";
import { SetupService } from "./auth/setup.ts";
import { BackupService, type BackupOptions } from "./history/backup.ts";
import { assertGit } from "./history/git.ts";
import { SYSTEM_AUTHOR, VaultHistory, type HistoryOptions } from "./history/history.ts";
import { describeConfig, type LoadedConfig } from "./config/index.ts";
import { errorFields } from "./errors.ts";
import { AssistantConfig, type AssistantConfigOptions } from "./assistant/config.ts";
import { SecretBox } from "./secrets/box.ts";
import { acquireLock } from "./lock.ts";
import { createLogger, type Logger } from "./log.ts";
import { Store } from "./store/index.ts";
import { createVaultIndexes } from "./search/index.ts";
import { findWebDir } from "./web.ts";
import { VaultService, type VaultHooks } from "./vault/service.ts";
import { VaultTrash } from "./vault/trash.ts";
import type { PluginCatalog } from "./mcp/dispatch.ts";
import type { AnyTool, ToolProvider } from "./mcp/registry.ts";

export const VERSION: string = pkg.version;

const SHUTDOWN_TIMEOUT_MS = 10_000;

export type ShutdownHook = () => void | Promise<void>;

export interface RunningServer {
  /** Base URL on the loopback or configured host, with the real port. */
  url: string;
  port: number;
  logger: Logger;
  /** Server-level metadata (accounts, tokens, audit log, …) in `<dataDir>/palimvo.db`. */
  store: Store;
  /** Passwords, sessions and invites. */
  auth: AuthService;
  /**
   * Registers work to run during shutdown, after new connections stop and before the lock is
   * released (e.g. saving live documents). Hooks run in reverse registration order.
   */
  onShutdown(name: string, hook: ShutdownHook): void;
  /** The services behind the API, for code that runs inside the server process (and tests). */
  services: {
    vaults: VaultService;
    history: VaultHistory;
    backup: BackupService;
    /** Assistant providers and their encrypted API keys. */
    assistant: AssistantConfig;
  };
  /** Idempotent. Resolves when everything has stopped. */
  close(): Promise<void>;
}

export interface StartOptions {
  loaded: LoadedConfig;
  logger?: Logger;
  shutdownTimeoutMs?: number;
  /** Other subsystems follow what the vault file layer does through these. */
  vaultHooks?: VaultHooks;
  /** Commit timing (tests make it short). */
  history?: Pick<HistoryOptions, "commitDelayMs" | "commitMaxDelayMs" | "maxFileBytes">;
  backup?: Pick<BackupOptions, "tickMs" | "allowLocalRemotes" | "credentials">;
  /** Extra MCP tools and per-vault tool providers (tests; later plugins). */
  mcp?: { tools?: AnyTool[]; providers?: ToolProvider[]; plugins?: PluginCatalog };
  /** Environment to read secrets from (tests), and hooks for the assistant provider setup. */
  assistant?: Pick<AssistantConfigOptions, "env" | "allowFake" | "factory" | "testTimeoutMs">;
}

export async function startServer({
  loaded,
  logger,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  vaultHooks,
  history: historyOptions,
  backup: backupOptions,
  mcp: mcpOptions,
  assistant: assistantOptions,
}: StartOptions): Promise<RunningServer> {
  const { config } = loaded;
  const log = logger ?? createLogger({ level: config.logLevel });
  // Version history is not optional: fail now with a clear message, not on the first save.
  const gitVersion = await assertGit();
  const lock = await acquireLock(config.dataDir);
  let store: Store | undefined;
  try {
    store = await Store.openInDataDir(config.dataDir);
    log.info("starting palimvo", {
      version: VERSION,
      node: process.version,
      git: gitVersion,
      ...describeConfig(loaded),
      schemaVersion: store.schemaVersion,
    });
    const openStore = store;

    const webDir = await findWebDir(config.webDir, import.meta.dirname);
    log.info(webDir ? "serving web app" : "no built web app found; serving the API only", {
      ...(webDir ? { dir: webDir } : {}),
    });

    let closing = false;
    const hooks: { name: string; hook: ShutdownHook }[] = [];
    // History needs the vault service's write queue, and the service needs a hook into history.
    const late: { history?: VaultHistory } = {};
    const vaults = new VaultService(path.join(config.dataDir, "vaults"), {
      logger: log,
      hooks: {
        legacyMetaRenamed: async (vault) => {
          await late.history?.commit(vault, {
            message: "Rename .aivault to .palimvo",
            author: SYSTEM_AUTHOR,
          });
          await vaultHooks?.legacyMetaRenamed?.(vault);
        },
      },
    });
    await vaults.init();
    const history = (late.history = new VaultHistory(path.join(config.dataDir, "vaults"), {
      logger: log,
      writeLock: (vault, fn) => vaults.exclusive(vault, fn),
      ...historyOptions,
    }));
    const backup = new BackupService(vaults, history, { logger: log, ...backupOptions });
    vaults.onChange((change) => {
      if (change.type === "removed") history.forget(change.vault);
      else if (change.external) history.noteUnrecorded(change.vault);
    });
    const trash = new VaultTrash(vaults, path.join(config.dataDir, "trash", "vaults"));
    // Registered first, so it runs last: after the server stopped taking requests, queued writes finish.
    hooks.push({
      name: "vaults",
      hook: async () => {
        await vaults.idle();
        vaults.close();
      },
    });
    // Registered after the vaults hook, so it runs before it: pending changes are committed first.
    hooks.push({
      name: "history",
      hook: async () => {
        backup.stop();
        // Let writes that are already running finish (and record their author) before the last commit.
        await vaults.idle();
        await history.flushAll();
      },
    });
    backup.start();
    const box = await SecretBox.load(config.dataDir, assistantOptions?.env ?? process.env);
    log.info("secret key loaded", { source: box.source });
    const assistant = new AssistantConfig({ store: openStore, box, ...assistantOptions });
    const auth = new AuthService(openStore);
    const setup = new SetupService(openStore, config.dataDir, {
      devInsecure: config.devInsecure,
      logger: log,
    });
    const pending = await setup.init();
    if (pending)
      log.warn("first-time setup required", {
        setupCode: pending.code,
        codeFile: setup.tokenFile,
        hint: "Open the server in a browser on this machine (no code needed), or enter the code from anywhere else.",
      });
    else if (config.devInsecure && !auth.hasAccounts)
      log.warn("--dev-insecure: the API is open until the first account exists");
    const app = createApp({
      webDir,
      logger: log,
      store: openStore,
      auth,
      setup,
      devInsecure: config.devInsecure,
      publicUrl: config.publicUrl,
      trustProxy: config.trustProxy,
      version: VERSION,
      ready: () => !closing,
      startedAt: Date.now(),
      vaults,
      trash,
      history: history,
      indexes: createVaultIndexes(vaults),
      backup,
      assistant,
      ...(mcpOptions?.tools ? { mcpTools: mcpOptions.tools } : {}),
      ...(mcpOptions?.providers ? { toolProviders: mcpOptions.providers } : {}),
      ...(mcpOptions?.plugins ? { plugins: mcpOptions.plugins } : {}),
    });

    const server = await listen(app.fetch, config.host, config.port);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    const url = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}`;
    log.info("listening", { url });

    let closed: Promise<void> | undefined;
    const close = () =>
      (closed ??= (async () => {
        closing = true;
        log.info("shutting down");
        const deadline = Date.now() + shutdownTimeoutMs;
        const force = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
        force.unref();
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        for (const { name, hook } of hooks.toReversed()) {
          try {
            await withTimeout(hook(), deadline - Date.now(), `shutdown hook "${name}" timed out`);
          } catch (err) {
            log.error("shutdown hook failed", { hook: name, ...errorFields(err) });
          }
        }
        await stopped;
        clearTimeout(force);
        openStore.close();
        await lock.release();
        log.info("shutdown complete");
      })());

    return {
      url,
      port,
      logger: log,
      store: openStore,
      auth,
      services: { vaults, history: history, backup, assistant },
      onShutdown: (name, hook) => void hooks.push({ name, hook }),
      close,
    };
  } catch (err) {
    store?.close();
    await lock.release();
    throw err;
  }
}

/** Rejects if `work` has not settled in `ms`, so one stuck hook cannot block shutdown forever. */
async function withTimeout<T>(work: T | Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(ms, 0));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function listen(
  fetch: (req: Request) => Response | Promise<Response>,
  hostname: string,
  port: number,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, hostname, port }, () => {
      server.off("error", reject);
      resolve(server as Server);
    });
    server.once("error", reject);
  });
}
