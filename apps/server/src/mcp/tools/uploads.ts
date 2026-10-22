import { z } from "zod";
import { publicBase, uploadCommands, uploadLinkPath } from "../../files/linkScripts.ts";
import { UPLOAD_PART_BYTES } from "../../files/sessions.ts";
import { cleanPath, invalid, mcpTool } from "./shared.ts";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MiB = 1024 * 1024;
const uploadId = z.string().min(1).describe("The id begin_upload returned.");

/** Pieces sent through a tool call stay modest: they travel as base64 inside the request. */
const MCP_PART_HINT = 8 * MiB;

export const beginUpload = mcpTool({
  name: "begin_upload",
  tier: "advanced",
  scope: "vault",
  permission: "file.upload",
  writes: true,
  input: z.object({
    path: z.string().min(1).describe("Where to store it, e.g. `videos/demo.mp4`."),
    size: z.number().int().min(0).describe("The whole file's size in bytes."),
    overwrite: z.boolean().optional().describe("Replace an existing file. Default false."),
  }),
  description: `Start a resumable upload of a file bigger than upload_file takes (up to 4 GiB). Then send upload_part pieces of about ${MCP_PART_HINT / MiB} MiB in order and call finish_upload. If the file is on disk where you can run commands, create_upload_link is simpler. Example: {path:'videos/demo.mp4', size:104857600}.`,
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    ctx.access.requireTree("file.upload", ctx.vault, path);
    const started = await ctx.deps.transfers.begin(ctx.vault, path, args.size, {
      create: !args.overwrite,
    });
    return {
      upload_id: started.id,
      path: started.path,
      size: started.size,
      received: started.received,
      max_part_bytes: UPLOAD_PART_BYTES,
    };
  },
});

export const uploadPart = mcpTool({
  name: "upload_part",
  tier: "advanced",
  scope: "vault",
  permission: "file.upload",
  writes: true,
  input: z.object({
    upload_id: uploadId,
    offset: z
      .number()
      .int()
      .min(0)
      .describe("Bytes already received; the first piece starts at 0."),
    content_base64: z.string().min(1).describe("The piece's bytes, base64 encoded."),
  }),
  description: `Send the next piece of an upload. offset must equal the bytes received so far (the reply says how many). A piece that failed can be sent again from the same offset. Example: {upload_id:'…', offset:0, content_base64:'…'}.`,
  handler: async (args, ctx) => {
    const sessions = ctx.deps.transfers.sessions;
    const status = await sessions.status(ctx.vault, args.upload_id);
    ctx.access.requireTree("file.upload", ctx.vault, status.path);
    const b64 = args.content_base64.replace(/\s+/g, "");
    if (!BASE64.test(b64) || Buffer.from(b64, "base64").toString("base64") !== b64)
      throw invalid("content_base64 is not valid base64.");
    const bytes = Buffer.from(b64, "base64");
    const next = await sessions.part(
      ctx.vault,
      args.upload_id,
      args.offset,
      new Blob([bytes]).stream(),
    );
    return { received: next.received, size: next.size, complete: next.received === next.size };
  },
});

export const finishUpload = mcpTool({
  name: "finish_upload",
  tier: "advanced",
  scope: "vault",
  permission: "file.upload",
  writes: true,
  input: z.object({ upload_id: uploadId }),
  description:
    "Save a fully received upload into the vault. Fails if some bytes are missing; send the rest with upload_part. Example: {upload_id:'…'}.",
  handler: async (args, ctx) => {
    const status = await ctx.deps.transfers.sessions.status(ctx.vault, args.upload_id);
    ctx.access.requireTree("file.upload", ctx.vault, status.path);
    const saved = await ctx.deps.transfers.finish(ctx.vault, args.upload_id, {
      author: ctx.author,
      note: ctx.note,
    });
    return { path: saved.path, size: saved.size, version: saved.version };
  },
});

export const cancelUpload = mcpTool({
  name: "cancel_upload",
  tier: "advanced",
  scope: "vault",
  permission: "file.upload",
  input: z.object({ upload_id: uploadId }),
  description:
    "Throw away an unfinished upload and the bytes already sent. Unfinished uploads also expire after a day. Example: {upload_id:'…'}.",
  handler: async (args, ctx) => {
    const status = await ctx.deps.transfers.sessions.status(ctx.vault, args.upload_id);
    ctx.access.requireTree("file.upload", ctx.vault, status.path);
    await ctx.deps.transfers.sessions.cancel(ctx.vault, args.upload_id);
    return { cancelled: true };
  },
});

export const createUploadLink = mcpTool({
  name: "create_upload_link",
  tier: "advanced",
  scope: "vault",
  permission: "file.upload",
  writes: true,
  input: z.object({
    path: z.string().min(1).describe("Where the file will be stored, e.g. `videos/demo.mp4`."),
    overwrite: z.boolean().optional().describe("Allow replacing an existing file. Default false."),
  }),
  description:
    "Make a one-use link (valid for a day) that uploads one file of any size up to 4 GiB without its bytes passing through you: run the returned bash or PowerShell command on the machine that has the file (replace the file path), or give the page url to a person. The change is credited to you. Example: {path:'videos/demo.mp4'}.",
  handler: async (args, ctx) => {
    const path = cleanPath(args.path);
    ctx.access.requireTree("file.upload", ctx.vault, path);
    const made = await ctx.deps.uploadLinks.create(ctx.vault, path, {
      create: !args.overwrite,
      author: ctx.author,
      ...(ctx.note.reason ? { reason: ctx.note.reason } : {}),
    });
    const url = `${publicBase(ctx.request, ctx.deps.publicUrl, ctx.deps.trustProxy)}${uploadLinkPath(made.token)}`;
    return {
      url,
      path: made.path,
      expires_at: made.expiresAt,
      bash: uploadCommands(url).bash,
      powershell: uploadCommands(url).powershell,
    };
  },
});
