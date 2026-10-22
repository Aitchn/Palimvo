// The one definition of how the server is bundled, shared by `pnpm build` and the bundle test.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Some dependencies (yaml) are CommonJS and call `require`; ESM output needs one handed to them. */
const REQUIRE_SHIM =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

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
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build(bundleOptions(fileURLToPath(new URL("../dist/palimvo.mjs", import.meta.url))));
}
