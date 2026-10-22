// The one definition of how the server is bundled, shared by `pnpm build` and the bundle test.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Some dependencies (yaml) are CommonJS and call `require`; ESM output needs one handed to them. */
const REQUIRE_SHIM =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

const WORKER_ENTRY = fileURLToPath(new URL("../src/plugins/sandbox/worker.ts", import.meta.url));
const WORKER_SOURCE_MODULE = /plugins[\\/]sandbox[\\/]workerSource\.ts$/;

/**
 * The plugin sandbox runs in worker threads. To keep `dist/palimvo.mjs` one file, the worker is
 * bundled on its own (CommonJS, so it can be started from a string) and its code is put into
 * `workerSource.ts`, which is otherwise a placeholder.
 */
const sandboxWorker = {
  name: "sandbox-worker",
  setup(b) {
    b.onLoad({ filter: WORKER_SOURCE_MODULE }, async () => {
      const result = await build({
        entryPoints: [WORKER_ENTRY],
        bundle: true,
        write: false,
        platform: "node",
        target: "node24",
        format: "cjs",
        logLevel: "silent",
      });
      const code = result.outputFiles[0].text;
      return {
        contents: `export const workerSource = ${JSON.stringify(code)};`,
        loader: "js",
        watchFiles: [WORKER_ENTRY],
      };
    });
  },
};

export function bundleOptions(
  outfile,
  entry = fileURLToPath(new URL("../src/index.ts", import.meta.url)),
) {
  return {
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outfile,
    banner: { js: REQUIRE_SHIM },
    plugins: [sandboxWorker],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build(bundleOptions(fileURLToPath(new URL("../dist/palimvo.mjs", import.meta.url))));
}
