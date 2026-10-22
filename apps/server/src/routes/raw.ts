import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { AppError, basename, supportedFileType } from "@palimvo/core";
import { accessOf } from "../auth/access.ts";
import { guestPolicy } from "../auth/principal.ts";
import type { AuthService } from "../auth/service.ts";
import type { UploadPolicy } from "../files/policy.ts";
import type { VaultService } from "../vault/service.ts";

/** Types a browser shows in place; everything else is offered as a download. */
const INLINE = /^(image|audio|video)\/|^application\/pdf$|^text\/plain|^application\/json$/;

/** `Content-Disposition` with an ASCII fallback and the real UTF-8 name. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The part of the path after `/api/vaults/<vault>/raw/`, percent-decoded exactly once. */
function rawPathOf(c: Context): string {
  // By position, not by searching for "/raw/": a vault may itself be called "raw".
  const rest = new URL(c.req.url).pathname.split("/").slice(5).join("/");
  try {
    return decodeURIComponent(rest);
  } catch {
    throw new AppError("invalid_path", undefined, { path: rest });
  }
}

type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * A single `bytes=a-b` range of a file of `size` bytes. Several ranges and other units are
 * ignored (null: send the whole file), which the protocol allows.
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const last = Number(m[2]);
    return last === 0 || size === 0
      ? "unsatisfiable"
      : { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Whether `If-None-Match` names this exact version. */
function matches(header: string | undefined, tag: string): boolean {
  return header?.split(",").some((t) => t.trim().replace(/^W\//, "") === tag) ?? false;
}

/**
 * `GET /api/vaults/:vault/raw/<path>`: a file's bytes as they are, for images, sound, video and
 * PDFs in notes. Supports byte ranges (seeking in media) and `ETag` revalidation. The file is
 * streamed, never read into memory.
 */
export function rawRoutes(vaults: VaultService, auth: AuthService, policy: UploadPolicy): Hono {
  const app = new Hono();

  app.get("/api/vaults/:vault/raw/*", async (c) => {
    const vault = c.req.param("vault");
    const target = rawPathOf(c);
    accessOf(c).requireVault("note.read", vault);
    const guest = guestPolicy(auth, c, vault);
    // A guest sees only what is public, and only through the file's own path (not a symlink).
    if (guest && (!guest.covers(target) || !(await vaults.isDirectPath(vault, target))))
      throw new AppError("not_found");
    const { abs, rel } = await vaults.locateFile(vault, target);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new AppError("not_found", undefined, { path: rel });
    if (guest) c.header("Cache-Control", "no-store");

    const supported = supportedFileType(rel, policy.pluginTypes(vault));
    const mime = supported?.mime ?? "application/octet-stream";
    const tag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
    c.header("Content-Type", mime);
    c.header("ETag", tag);
    if (!guest) c.header("Cache-Control", "private, no-cache");
    c.header("Accept-Ranges", "bytes");
    c.header(
      "Content-Disposition",
      // `?download=1` asks for a save-as even for types a browser could show.
      disposition(
        INLINE.test(mime) && c.req.query("download") !== "1" ? "inline" : "attachment",
        basename(rel),
      ),
    );
    // A vault file is user content: never let the browser guess it is a page, and never run it as one.
    c.header("X-Content-Type-Options", "nosniff");
    // (The sandbox is left off PDFs only because browsers' built-in PDF viewers refuse to run in one.)
    if (mime !== "application/pdf")
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");

    if (matches(c.req.header("if-none-match"), tag)) return c.body(null, 304);

    // `If-Range`: a range only applies to the version the client already holds part of.
    const ifRange = c.req.header("if-range");
    const wanted = ifRange === undefined || ifRange === tag ? c.req.header("range") : undefined;
    const range = parseRange(wanted, info.size);
    if (range === "unsatisfiable") {
      c.header("Content-Range", `bytes */${info.size}`);
      return c.body(null, 416);
    }
    if (info.size === 0) {
      c.header("Content-Length", "0");
      return c.body(null, 200);
    }
    const { start, end } = range ?? { start: 0, end: info.size - 1 };
    c.header("Content-Length", String(end - start + 1));
    if (range) c.header("Content-Range", `bytes ${start}-${end}/${info.size}`);
    const stream = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
    return c.body(stream, range ? 206 : 200);
  });

  return app;
}
