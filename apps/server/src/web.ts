import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { AppError } from "@palimvo/core";
import { AppError as ConfigError } from "./errors.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Paths that belong to the server's own API: a miss there is a JSON 404, never the web app. */
const API_PREFIXES = ["/api/", "/mcp", "/oauth", "/.well-known/"];

/** Files Vite names by content hash can be cached for good; everything else must be revalidated. */
function cacheControl(urlPath: string): string {
  return urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

async function fileIn(
  dir: string,
  urlPath: string,
): Promise<{ abs: string; size: number; mtime: number } | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const abs = path.join(dir, decoded);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  const info = await stat(abs).catch(() => null);
  return info?.isFile() ? { abs, size: info.size, mtime: info.mtimeMs } : null;
}

/**
 * Serves the built web app from `dir` and falls back to `index.html` for addresses without a
 * file, so deep links such as `/v/notes/Projects/Plan.md` open the single-page app.
 * Mount it after the API routes.
 */
export function webRoutes(dir: string): Hono {
  const root = path.resolve(dir);
  const app = new Hono();
  app.use("*", compress());

  app.on(["GET", "HEAD"], "*", async (c) => {
    const urlPath = new URL(c.req.url).pathname;
    if (API_PREFIXES.some((p) => urlPath === p.replace(/\/$/, "") || urlPath.startsWith(p))) {
      throw new AppError("not_found");
    }
    let target = await fileIn(root, urlPath === "/" ? "/index.html" : urlPath);
    let served = urlPath;
    if (!target) {
      // A missing file that something other than a page navigation asked for is a real 404.
      // Page navigations get the app, which shows its own not-found page (deep links to
      // `/v/notes/Plan.md` have a file extension too).
      const navigation = c.req.header("accept")?.includes("text/html") ?? false;
      if (path.extname(urlPath) !== "" && !navigation) throw new AppError("not_found");
      target = await fileIn(root, "/index.html");
      served = "/index.html";
      if (!target) throw new AppError("not_found");
    }
    const tag = `W/"${target.size.toString(16)}-${Math.trunc(target.mtime).toString(16)}"`;
    c.header("ETag", tag);
    c.header("Cache-Control", cacheControl(served));
    c.header(
      "Content-Type",
      TYPES[path.extname(target.abs).toLowerCase()] ?? "application/octet-stream",
    );
    if (c.req.header("if-none-match") === tag) return c.body(null, 304);
    if (c.req.method === "HEAD") return c.body(null, 200);
    return c.body(Readable.toWeb(createReadStream(target.abs)) as ReadableStream);
  });

  return app;
}

/** The first folder that holds a built web app: the configured one, `web/` next to the bundle, the monorepo's `apps/web/dist`. */
export async function findWebDir(
  configured: string | undefined,
  here: string,
): Promise<string | undefined> {
  const candidates = [
    ...(configured ? [path.resolve(configured)] : []),
    path.resolve(here, "web"),
    path.resolve(here, "../../web/dist"),
  ];
  for (const candidate of candidates) {
    if ((await stat(path.join(candidate, "index.html")).catch(() => null))?.isFile())
      return candidate;
    if (configured && candidate === path.resolve(configured)) {
      throw new ConfigError(
        "config_invalid",
        400,
        `PALIMVO_WEB_DIR has no index.html: ${candidate}`,
      );
    }
  }
  return undefined;
}
