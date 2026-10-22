import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, type Config } from "../src/config/index.ts";
import { createLogger, type LogLevel } from "../src/log.ts";
import { startServer, type RunningServer, type StartOptions } from "../src/server.ts";

export interface TestServer extends RunningServer {
  dataDir: string;
  /** Log lines written so far, parsed. */
  logs: Record<string, unknown>[];
  /** Fetches a path on this server. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Stops the server and deletes the temporary data directory. */
  dispose(): Promise<void>;
}

/** Starts a server on a random port with a throwaway data directory. */
export async function startTestServer(
  overrides: Partial<Config> = {},
  options: Pick<StartOptions, "history" | "backup"> = {},
): Promise<TestServer> {
  const dataDir = overrides.dataDir ?? (await mkdtemp(path.join(tmpdir(), "palimvo-test-")));
  const config: Config = {
    ...defaultConfig(),
    logLevel: "debug",
    // Most tests exercise the API without the setup wizard; setup.test.ts turns this off.
    devInsecure: true,
    ...overrides,
    dataDir,
    port: overrides.port ?? 0,
  };
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: config.logLevel,
    write: (_level: LogLevel, line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const sources = Object.fromEntries(Object.keys(config).map((k) => [k, "default"])) as never;
  const running = await startServer({
    loaded: { config, sources },
    logger,
    shutdownTimeoutMs: 2000,
    // Long enough that tests decide when to commit; no credentials from the developer's environment.
    history: { commitDelayMs: 60_000, commitMaxDelayMs: 60_000, ...options.history },
    backup: { credentials: null, ...options.backup },
  });
  return {
    ...running,
    dataDir,
    logs,
    fetch: (p, init) => fetch(new URL(p, running.url), init),
    dispose: async () => {
      await running.close();
      // Windows may hold a directory briefly after handles close (EBUSY, EPERM).
      await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}
