import { fileKind, mediaOf } from "./paths.ts";

/** A file type some enabled plugin added to a vault's allow-list. */
export interface VaultFileType {
  extension: string;
  mime: string;
  maxBytes: number;
  description?: string;
  /** Every running plugin that declared it (sorted by id). */
  plugins: string[];
}

/** Largest single file accepted in one request unless a type says otherwise (64 MiB). */
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Largest file accepted through chunked upload (4 GiB). */
export const MAX_CHUNKED_FILE_BYTES = 4 * 1024 * 1024 * 1024;

export const DEFAULT_FILE_MIME = "application/octet-stream";

/** Documents every vault accepts besides notes and media, with the type they are sent as. */
export const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  // Stored and served as text, never as image/svg+xml: an SVG opened as a page could run its scripts.
  // The app draws it through <img> (which never runs them) and plugins in their sandbox.
  svg: "text/plain; charset=utf-8",
};

/** Built-in documents that are plain text: shown in the text viewer and read as text by AIs. */
export const TEXT_DOCUMENTS: ReadonlySet<string> = new Set([
  "txt",
  "csv",
  "json",
  "yaml",
  "yml",
  "svg",
]);

/** The lowercase extension of a path's last segment ("" when it has none). */
export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether a path is a built-in plain-text document (txt, csv, json, yaml, svg). */
export function isTextDocument(path: string): boolean {
  return fileKind(path) === "other" && TEXT_DOCUMENTS.has(fileExtension(path));
}

/**
 * Where a supported file type comes from: notes, canvases and bases are live documents,
 * media and documents are built in, the rest are registered by enabled plugins.
 */
export type SupportedFileType =
  | { source: "note"; mime: string }
  | { source: "media" | "document"; mime: string }
  | { source: "plugin"; mime: string; maxBytes: number; plugins: string[] };

/** The plugin-declared type for a path, if its extension is in `types`. */
export function declaredFileType(
  path: string,
  types: readonly VaultFileType[],
): VaultFileType | undefined {
  const ext = fileExtension(path);
  return ext ? types.find((t) => t.extension === ext) : undefined;
}

/**
 * Whether the vault can hold this file, and how; undefined when nothing in the vault supports it.
 * `types` are the vault's plugin-declared types.
 */
export function supportedFileType(
  path: string,
  types: readonly VaultFileType[] = [],
): SupportedFileType | undefined {
  const kind = fileKind(path);
  if (kind !== "other")
    return {
      source: "note",
      mime: kind === "canvas" ? "application/json" : "text/plain; charset=utf-8",
    };
  const media = mediaOf(path);
  if (media) return { source: "media", mime: media.type };
  const mime = DOCUMENT_TYPES[fileExtension(path)];
  if (mime) return { source: "document", mime };
  const declared = declaredFileType(path, types);
  return declared
    ? {
        source: "plugin",
        mime: declared.mime,
        maxBytes: declared.maxBytes,
        plugins: [...declared.plugins],
      }
    : undefined;
}
