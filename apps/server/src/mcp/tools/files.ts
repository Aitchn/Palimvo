import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { AppError, DEFAULT_MAX_FILE_BYTES, supportedFileType } from "@palimvo/core";
import { toolContent } from "../registry.ts";
import { bytesVersion } from "../../vault/fsutil.ts";
import { cleanPath, invalid, pathArg, readableIn, mcpTool } from "./shared.ts";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Images up to this size are returned as image content the model can look at. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export const uploadFile = mcpTool({
  name: "upload_file",
  tier: "native",
  scope: "vault",
  permission: "file.upload",
  writes: true,
  input: z.object({
    path: pathArg("Where to store it, e.g. `assets/logo.png`."),
    content_base64: z.string().min(1).describe("The file's bytes, base64 encoded."),
    overwrite: z.boolean().optional().describe("Replace an existing file. Default false."),
  }),
  description: `Store a binary file (image, audio, video, PDF, ...) up to ${DEFAULT_MAX_FILE_BYTES / 1024 / 1024} MiB. Notes and canvases go through create_note. Example: {path:'assets/logo.png', content_base64:'iVBORw0...'}.`,
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    ctx.access.requireTree("file.upload", ctx.vault, path);
    const b64 = args.content_base64.replace(/\s+/g, "");
    if (!BASE64.test(b64) || Buffer.from(b64, "base64").toString("base64") !== b64)
      throw invalid("content_base64 is not valid base64.");
    const written = await ctx.deps.transfers
      .upload(ctx.vault, path, Buffer.from(b64, "base64"), {
        // Without `overwrite` the file must not exist yet.
        create: !args.overwrite,
        actor: { author: ctx.author, note: ctx.note },
      })
      .catch((err: unknown) => {
        if (
          err instanceof AppError &&
          (err.code === "version_conflict" || err.code === "already_exists")
        )
          throw new AppError(
            "already_exists",
            undefined,
            { path },
            { message: `${path} already exists. Pass overwrite:true to replace it.` },
          );
        throw err;
      });
    return { path: written.path, size: written.size, version: written.version };
  },
});

export const downloadFile = mcpTool({
  name: "download_file",
  tier: "native",
  scope: "vault",
  permission: "note.read",
  input: z.object({ path: pathArg("Any file; text files are better read with read_note.") }),
  description: `Get a file's bytes (base64) up to ${DEFAULT_MAX_FILE_BYTES / 1024 / 1024} MiB. Small images are returned so you can look at them. Example: {path:'assets/logo.png'}.`,
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    readableIn(ctx).require(path);
    const { abs, rel } = await ctx.deps.vaults.locateFile(ctx.vault, path);
    let info;
    try {
      info = await stat(abs);
    } catch {
      throw new AppError("not_found", undefined, { path: rel });
    }
    if (!info.isFile()) throw new AppError("not_found", undefined, { path: rel });
    if (info.size > DEFAULT_MAX_FILE_BYTES)
      throw new AppError("payload_too_large", undefined, {
        path: rel,
        limit: DEFAULT_MAX_FILE_BYTES,
      });
    const bytes = await readFile(abs);
    const mime =
      supportedFileType(rel, ctx.deps.transfers.policy.pluginTypes(ctx.vault))?.mime ??
      "application/octet-stream";
    const meta = { path: rel, size: bytes.byteLength, mime, version: bytesVersion(bytes) };
    if (
      mime.startsWith("image/") &&
      mime !== "image/svg+xml" &&
      bytes.byteLength <= MAX_INLINE_IMAGE_BYTES
    )
      return toolContent([
        { type: "text", text: JSON.stringify(meta) },
        { type: "image", data: bytes.toString("base64"), mimeType: mime },
      ]);
    return { ...meta, content_base64: bytes.toString("base64") };
  },
});
