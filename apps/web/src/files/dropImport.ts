import { MAX_CHUNKED_FILE_BYTES, fileKind, isTextDocument, joinPath } from "@palimvo/core";
import { ApiError } from "../api/errors.ts";
import { writeFile } from "../api/files.ts";
import { uploadFile } from "../api/uploads.ts";
import { uploadQueue } from "../uploads/queue.ts";
import { uniqueName } from "./model.ts";

/** A file to bring in, with the folder-relative path it should get (`photos/a.md`). */
export interface ImportItem {
  path: string;
  file: File;
}

export interface ImportResult {
  imported: string[];
  /** Hidden, too big, or a kind of file the vault does not accept: left out on purpose. */
  skipped: number;
  /** The server refused or could not be reached. */
  failed: number;
}

/** Same ceiling as the server's text limit. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const PARALLEL = 4;

interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (file: File) => void, fail: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (entries: Entry[]) => void, fail: (error: unknown) => void) => void;
  };
}

async function walk(entry: Entry, prefix: string, out: ImportItem[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail));
    out.push({ path: joinPath(prefix, entry.name), file });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const dir = joinPath(prefix, entry.name);
    for (;;) {
      // readEntries returns the folder in batches until it returns an empty one.
      const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, dir, out);
    }
  }
}

/** Files (and the files inside dropped folders) carried by a drop. Call it inside the drop event handler. */
export function collectDropped(data: DataTransfer): Promise<ImportItem[]> {
  // The entries must be read now: the browser empties `data.items` after the handler returns.
  const entries: Entry[] = [];
  for (const item of Array.from(data.items ?? [])) {
    const entry =
      item.kind === "file" ? (item.webkitGetAsEntry?.() as Entry | null | undefined) : null;
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    return Promise.resolve(Array.from(data.files ?? []).map((file) => ({ path: file.name, file })));
  }
  return (async () => {
    const out: ImportItem[] = [];
    for (const entry of entries) await walk(entry, "", out);
    return out;
  })();
}

/** Notes, canvases, databases and the plain-text documents are written as text; everything else is uploaded. */
export function isTextImport(path: string): boolean {
  return fileKind(path) !== "other" || isTextDocument(path);
}

/** Text of a file, or `null` when it is not valid UTF-8 text. */
async function readText(file: File): Promise<string | null> {
  const bytes = await file.arrayBuffer();
  const view = new Uint8Array(bytes);
  if (view.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    return null;
  }
}

export interface ImportOptions {
  /** Turns a failure into a sentence for the upload panel. */
  describe?: (error: unknown) => string;
}

/**
 * Brings files into `folder`: text goes in as notes, anything else (images, sound, video, PDFs and
 * the types plugins add) is uploaded with a progress bar. Nothing is overwritten: a name already
 * taken gets a number (`Note 2.md`). `taken` says which paths exist, to pick numbers without a
 * request per try.
 */
export async function importItems(
  vault: string,
  folder: string,
  items: ImportItem[],
  taken: (path: string) => boolean,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: 0, failed: 0 };
  const claimed = new Set<string>();
  const exists = (path: string) => taken(path) || claimed.has(path.toLowerCase());

  /** Runs `send` for the first free name; returns false when the file could not be stored. */
  const place = async (item: ImportItem, send: (target: string) => Promise<void>) => {
    const dir = joinPath(folder, item.path.split("/").slice(0, -1).join("/"));
    const name = item.path.split("/").at(-1) as string;
    for (let attempt = 0; attempt < 5; attempt++) {
      const free = uniqueName(name, (candidate) => exists(joinPath(dir, candidate)));
      const target = joinPath(dir, free);
      claimed.add(target.toLowerCase());
      try {
        await send(target);
        result.imported.push(target);
        return;
      } catch (error) {
        // Someone created it since the tree was read: try the next number.
        if (
          error instanceof ApiError &&
          (error.code === "version_conflict" || error.code === "already_exists")
        ) {
          continue;
        }
        if (error instanceof ApiError && error.code === "unsupported_type") {
          result.skipped++;
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") return;
        result.failed++;
        return;
      }
    }
    result.failed++;
  };

  const sendText = async (item: ImportItem) => {
    if (item.file.size > MAX_TEXT_BYTES) {
      result.skipped++;
      return;
    }
    const content = await readText(item.file);
    if (content === null) {
      result.skipped++;
      return;
    }
    await place(item, async (target) => {
      await writeFile(vault, target, content, null);
    });
  };

  const sendFile = async (item: ImportItem) => {
    if (item.file.size > MAX_CHUNKED_FILE_BYTES) {
      result.skipped++;
      return;
    }
    await place(item, async (target) => {
      const handle = uploadQueue.start(target, item.file.size);
      try {
        await uploadFile(vault, target, item.file, {
          create: true,
          signal: handle.signal,
          onProgress: (sent) => handle.progress(sent),
        });
        handle.done();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") handle.cancelled();
        else if (
          error instanceof ApiError &&
          ["already_exists", "version_conflict", "unsupported_type"].includes(error.code)
        )
          handle.cancelled();
        else handle.fail(options.describe?.(error) ?? String(error));
        throw error;
      }
    });
  };

  const one = async (item: ImportItem) => {
    const hidden = item.path.split("/").some((part) => part.startsWith("."));
    if (hidden) {
      result.skipped++;
      return;
    }
    await (isTextImport(item.path) ? sendText(item) : sendFile(item));
  };

  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.all(items.slice(i, i + PARALLEL).map(one));
  }
  return result;
}
