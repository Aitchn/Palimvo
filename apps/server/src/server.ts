import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.ts";
import { describeConfig, type LoadedConfig } from "./config/index.ts";
import { errorFields } from "./errors.ts";
import { acquireLock } from "./lock.ts";
import { createLogger, type Logger } from "./log.ts";

export const VERSION: string = pkg.version;

const SHUTDOWN_TIMEOUT_MS = 10_000;

export type ShutdownHook = () => void | Promise<void>;

export interface RunningServer {
  /** Base URL on the loopback or configured host, with the real port. */
  url: string;
  port: number;
  logger: Logger;
  /**
   * Registers work to run during shutdown, after new connections stop and before the lock is
   * released (e.g. saving live documents). Hooks run in reverse registration order.
   */
  onShutdown(name: string, hook: ShutdownHook): void;
  /** Idempotent. Resolves when everything has stopped. */
  close(): Promise<void>;
}

export interface StartOptions {
  loaded: LoadedConfig;
  logger?: Logger;
  shutdownTimeoutMs?: number;
}

export async function startServer({
  loaded,
  logger,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
}: StartOptions): Promise<RunningServer> {
  const { config } = loaded;
  const log = logger ?? createLogger({ level: config.logLevel });
  const lock = await acquireLock(config.dataDir);
  try {
    log.info("starting palimvo", {
      version: VERSION,
      node: process.version,
      ...describeConfig(loaded),
    });

    let closing = false;
    const hooks: { name: string; hook: ShutdownHook }[] = [];
    const app = createApp({
      logger: log,
      version: VERSION,
      ready: () => !closing,
      startedAt: Date.now(),
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
        await lock.release();
        log.info("shutdown complete");
      })());

    return {
      url,
      port,
      logger: log,
      onShutdown: (name, hook) => void hooks.push({ name, hook }),
      close,
    };
  } catch (err) {
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
