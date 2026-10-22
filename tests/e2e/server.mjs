// Runs the built Palimvo server on a throwaway data folder for the tests that need the real
// thing (live editing). Playwright starts it and stops it with SIGTERM.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = mkdtempSync(path.join(tmpdir(), "palimvo-e2e-"));
const child = spawn(
  process.execPath,
  [
    path.join(root, "apps/server/dist/palimvo.mjs"),
    "serve",
    "--data-dir",
    dataDir,
    "--host",
    "127.0.0.1",
    "--port",
    process.env.E2E_SERVER_PORT ?? "4174",
    "--web-dir",
    path.join(root, "apps/web/dist"),
    "--log-level",
    "warn",
  ],
  { stdio: "inherit" },
);

let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the folder is in the OS temp directory anyway */
  }
  process.exit(code);
};
child.on("exit", (code) => finish(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill("SIGTERM"));
