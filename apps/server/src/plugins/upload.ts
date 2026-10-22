import { z } from "zod";
import { AppError } from "@palimvo/core";
import { MANIFEST_LIMITS, type PluginFile } from "@palimvo/plugin-sdk";

/** One file of a package as sent over HTTP or MCP: text, or base64 for binary files. */
export const packageFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(200)
      .describe("Path inside the package, e.g. `manifest.json` or `locales/en.json`."),
    text: z.string().optional().describe("The file's text (UTF-8)."),
    base64: z.string().optional().describe("The file's bytes, base64 encoded, for binary files."),
  })
  .refine((f) => (f.text === undefined) !== (f.base64 === undefined), {
    message: "give either text or base64 for each file",
  });

export const packageFilesSchema = z
  .array(packageFileSchema)
  .min(1)
  .max(MANIFEST_LIMITS.packageFiles);

export type PackageFileInput = z.infer<typeof packageFileSchema>;

/** Longest base64 string that could still decode to a package within the size limit. */
const MAX_BASE64 = Math.ceil((MANIFEST_LIMITS.packageBytes * 4) / 3) + 4;

/** Turns request files into package files. Size and path rules are checked by `inspectPackage`. */
export function toPluginFiles(files: readonly PackageFileInput[]): PluginFile[] {
  let total = 0;
  return files.map((f) => {
    if (f.base64 !== undefined && f.base64.length > MAX_BASE64) throw tooLarge();
    if (f.base64 !== undefined && !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64))
      throw new AppError(
        "invalid_request",
        undefined,
        { path: f.path },
        {
          message: `${f.path}: base64 is not valid.`,
        },
      );
    const bytes =
      f.base64 !== undefined
        ? new Uint8Array(Buffer.from(f.base64, "base64"))
        : new TextEncoder().encode(f.text ?? "");
    total += bytes.length;
    if (total > MANIFEST_LIMITS.packageBytes) throw tooLarge();
    return { path: f.path, bytes };
  });
}

const tooLarge = () =>
  new AppError(
    "payload_too_large",
    undefined,
    { limit: MANIFEST_LIMITS.packageBytes },
    {
      message: `A plugin package may be at most ${MANIFEST_LIMITS.packageBytes} bytes.`,
    },
  );

const TEXT = new TextDecoder("utf-8", { fatal: true });
const MAX_INLINE_TEXT = 256 * 1024;

/** Files as the review screen shows them: text when it is UTF-8 and not huge. */
export function describeFiles(files: readonly PluginFile[]): {
  path: string;
  size: number;
  text?: string;
}[] {
  return files.map((f) => {
    let text: string | undefined;
    if (f.bytes.length <= MAX_INLINE_TEXT) {
      try {
        text = TEXT.decode(f.bytes);
      } catch {
        text = undefined;
      }
    }
    return { path: f.path, size: f.bytes.length, ...(text === undefined ? {} : { text }) };
  });
}
