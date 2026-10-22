import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  powershellScript,
  publicBase,
  shellScript,
  uploadLinkPath,
  uploadPage,
} from "../files/linkScripts.ts";
import type { UploadLinks } from "../files/links.ts";
import { UPLOAD_PART_BYTES } from "../files/sessions.ts";
import { readJson } from "./util.ts";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "@palimvo/core";

const beginBody = z.object({ size: z.number().int().min(0) });

/**
 * Routes under `/api/upload-links/<token>`, open without signing in: the token is the permission.
 * GET answers browsers with an upload page and programs with the link's state as JSON. They are
 * mounted before the session and CSRF checks, since a script run from a terminal carries neither.
 */
export function uploadLinkRoutes(
  links: UploadLinks,
  options: { publicUrl: string | undefined; trustProxy: boolean },
): Hono {
  const app = new Hono();
  const noStore = { "cache-control": "no-store" };
  const base = (c: Parameters<typeof publicBase>[0], token: string) =>
    `${publicBase(c, options.publicUrl, options.trustProxy)}${uploadLinkPath(token)}`;

  app.get("/api/upload-links/:token", async (c) => {
    const token = c.req.param("token");
    if (/text\/html/.test(c.req.header("accept") ?? "")) {
      const info = await links.info(token).catch(() => null);
      const nonce = randomBytes(16).toString("base64");
      return c.html(
        uploadPage(info ? { path: info.path, expiresAt: info.expiresAt } : null, nonce),
        info ? 200 : 404,
        {
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
          ...noStore,
          "referrer-policy": "no-referrer",
        },
      );
    }
    return c.json(await links.info(token), 200, noStore);
  });

  app.post("/api/upload-links/:token/begin", async (c) => {
    const { size } = await readJson(c, beginBody);
    return c.json(await links.begin(c.req.param("token"), size), 200, noStore);
  });

  app.put(
    "/api/upload-links/:token/parts",
    bodyLimit({
      maxSize: UPLOAD_PART_BYTES,
      onError: () => {
        throw new AppError("payload_too_large", undefined, { limit: UPLOAD_PART_BYTES });
      },
    }),
    async (c) =>
      c.json(
        await links.part(c.req.param("token"), Number(c.req.query("offset")), c.req.raw.body),
        200,
        noStore,
      ),
  );

  app.post("/api/upload-links/:token/finish", async (c) =>
    c.json(await links.finish(c.req.param("token")), 201, noStore),
  );

  app.get("/api/upload-links/:token/upload.sh", async (c) => {
    const token = c.req.param("token");
    await links.info(token);
    return c.text(shellScript(base(c, token)), 200, noStore);
  });

  app.get("/api/upload-links/:token/upload.ps1", async (c) => {
    const token = c.req.param("token");
    await links.info(token);
    return c.text(powershellScript(base(c, token)), 200, noStore);
  });

  return app;
}
