import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiTarget = `http://localhost:${process.env.PALIMVO_PORT ?? 3000}`;

/** Files under public/ the service worker should keep offline (relative paths, as served). */
function publicFiles(dir: string, base = ""): string[] {
  return readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((entry) => {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    return entry.isDirectory() ? publicFiles(dir, rel) : [rel];
  });
}

/** Writes /sw.js from sw-template.js with this build's file list, so each deploy gets a new cache. */
function serviceWorker(): Plugin {
  return {
    name: "palimvo-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      // What the first page load needs: the entry chunks, everything they import up front, their CSS.
      const entry = new Set<string>();
      const visit = (name: string) => {
        const chunk = bundle[name];
        if (!chunk || entry.has(name)) return;
        entry.add(name);
        if (chunk.type !== "chunk") return;
        chunk.imports.forEach(visit);
        chunk.viteMetadata?.importedCss.forEach((css) => entry.add(css));
      };
      Object.values(bundle).forEach((file) => {
        if (file.type === "chunk" && file.isEntry) visit(file.fileName);
      });
      // The app awaits its locale files before it starts, so they are part of the first load.
      Object.values(bundle).forEach((file) => {
        if (
          file.type === "chunk" &&
          /[\\/]locales[\\/][\w-]+\.json$/.test(file.facadeModuleId ?? "")
        ) {
          visit(file.fileName);
        }
      });
      const publicDir = path.resolve(here, "public");
      const publics = publicFiles(publicDir);
      const files = [...entry, ...publics].map((name) => `/${name}`).sort();
      // Names alone would miss a changed manifest or icon; hash the public files' bytes too.
      const version = createHash("sha256")
        .update(Object.keys(bundle).sort().join("\n"))
        .update(files.join("\n"))
        .update(
          Buffer.concat(publics.sort().map((name) => readFileSync(path.join(publicDir, name)))),
        )
        .digest("hex")
        .slice(0, 12);
      const source = readFileSync(path.resolve(here, "sw-template.js"), "utf8")
        .replace('"__CACHE__"', JSON.stringify(`palimvo-shell-${version}`))
        .replace("/*__PRECACHE__*/", files.map((f) => JSON.stringify(f)).join(", "));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, ws: true },
      "/mcp": { target: apiTarget },
      "/oauth": { target: apiTarget },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
