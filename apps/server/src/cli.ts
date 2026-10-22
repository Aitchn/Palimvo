import { parseArgs } from "node:util";
import { BARE_CONFIG_FLAGS, CONFIG_FLAGS, loadConfig } from "./config/index.ts";
import { AppError, errorFields } from "./errors.ts";
import { createLogger } from "./log.ts";
import { startServer, VERSION } from "./server.ts";

const HELP = `Usage: palimvo <command> [options]

Commands:
  serve      Start the server
  version    Print the version
  help       Show this help

Options for serve (each also has a PALIMVO_* environment variable):
  --data-dir <path>     PALIMVO_DATA_DIR      Where data lives (default ./data)
  --host <address>      PALIMVO_HOST          Address to listen on (default 127.0.0.1)
  --port <number>       PALIMVO_PORT          Port to listen on (default 3000)
  --public-url <url>    PALIMVO_PUBLIC_URL    Public address, needed for OAuth
  --trust-proxy <bool>  PALIMVO_TRUST_PROXY   Trust X-Forwarded-* headers (default false)
  --log-level <level>   PALIMVO_LOG_LEVEL     debug, info, warn or error (default info)
  --plugin-workers <n>  PALIMVO_PLUGIN_WORKERS  Worker threads for plugin tools (default 4)
  --dev-insecure        PALIMVO_DEV_INSECURE  Leave the API open until the first account exists,
                                              skipping the setup wizard. Development only; refused
                                              unless the host is a loopback address.
`;

/** Runs the CLI and returns the process exit code. `serve` resolves only after shutdown. */
export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const [command = "help", ...rest] = argv;
  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    case "serve":
      return serve(rest, env);
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

async function serve(args: string[], env: Record<string, string | undefined>): Promise<number> {
  const logger = createLogger({ level: "info" });
  try {
    const { values } = parseArgs({
      args,
      options: Object.fromEntries(
        CONFIG_FLAGS.map((f) => [
          f,
          { type: BARE_CONFIG_FLAGS.includes(f) ? ("boolean" as const) : ("string" as const) },
        ]),
      ),
    });
    const loaded = loadConfig(
      env,
      Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, typeof v === "boolean" ? String(v) : v]),
      ),
    );
    const running = await startServer({
      loaded,
      logger: createLogger({ level: loaded.config.logLevel }),
    });

    const done = new Promise<void>((resolve) => {
      const stop = (signal: string) => {
        running.logger.info("received signal", { signal });
        void running.close().finally(resolve);
      };
      process.once("SIGTERM", () => stop("SIGTERM"));
      process.once("SIGINT", () => stop("SIGINT"));
    });
    process.on("unhandledRejection", (reason) =>
      running.logger.error("unhandled rejection", errorFields(reason)),
    );
    process.on("uncaughtException", (err) => {
      // State may be corrupt: exit and let the supervisor start a clean process.
      running.logger.error("uncaught exception", errorFields(err));
      process.exit(1);
    });
    await done;
    return 0;
  } catch (err) {
    if (err instanceof AppError || (err instanceof Error && "code" in err)) {
      console.error(`palimvo: ${err.message}`);
    } else {
      logger.error("failed to start", errorFields(err));
    }
    return 1;
  }
}
