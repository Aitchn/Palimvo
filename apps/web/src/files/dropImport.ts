import { joinPath } from "@palimvo/core";
import { ApiError } from "../api/errors.ts";
import { writeFile } from "../api/files.ts";
import { uniqueName } from "./model.ts";

/** A file to bring in, with the folder-relative path it should get (`photos/a.md`). */
export interface ImportItem {
  path: string;
  file: File;
}

export interface ImportResult {
  imported: string[];
  /** Not text, too big, or hidden: left out on purpose. */
  skipped: number;
  /** The server refused or could not be reached. */
  failed: number;
}

/** Same ceiling as the server's text limit. */
const MAX_BYTES = 64 * 1024 * 1024;
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

/** Text of a file, or `null` when it is not valid UTF-8 text (binary uploads are a later feature). */
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

/**
 * Writes text files into `folder`. Nothing is overwritten: a name already taken gets a number
 * (`Note 2.md`). `taken` says which paths exist, to pick numbers without a request per try.
 */
export async function importItems(
  vault: string,
  folder: string,
  items: ImportItem[],
  taken: (path: string) => boolean,
): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: 0, failed: 0 };
  const claimed = new Set<string>();
  const exists = (path: string) => taken(path) || claimed.has(path.toLowerCase());

  const one = async (item: ImportItem) => {
    const hidden = item.path.split("/").some((part) => part.startsWith("."));
    if (hidden || item.file.size > MAX_BYTES) {
      result.skipped++;
      return;
    }
    const content = await readText(item.file);
    if (content === null) {
      result.skipped++;
      return;
    }
    const dir = joinPath(folder, item.path.split("/").slice(0, -1).join("/"));
    const name = item.path.split("/").at(-1) as string;
    for (let attempt = 0; attempt < 5; attempt++) {
      const free = uniqueName(name, (candidate) => exists(joinPath(dir, candidate)));
      const target = joinPath(dir, free);
      claimed.add(target.toLowerCase());
      try {
        await writeFile(vault, target, content, null);
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
        result.failed++;
        return;
      }
    }
    result.failed++;
  };

  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.all(items.slice(i, i + PARALLEL).map(one));
  }
  return result;
}
