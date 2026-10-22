import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { AppError, MAX_CHUNKED_FILE_BYTES } from "@palimvo/core";
import { KeyedMutex } from "../vault/mutex.ts";
import type { VaultService } from "../vault/service.ts";

/** Largest piece sent in one request: well under the 100 MB a free Cloudflare plan lets through. */
export const UPLOAD_PART_BYTES = 32 * 1024 * 1024;
/** An upload nobody added to for this long is thrown away. */
export const UPLOAD_IDLE_MS = 24 * 60 * 60 * 1000;
/** Unfinished uploads one vault may hold at once. */
export const MAX_OPEN_UPLOADS = 20;
/** Free disk space that must remain once every byte of an upload has arrived. */
const DISK_MARGIN_BYTES = 512 * 1024 * 1024;
const DIR = "uploads";
const ID = /^[a-f0-9]{32}$/;

export interface UploadStatus {
  id: string;
  path: string;
  size: number;
  received: number;
  partBytes: number;
}

export interface UploadMeta {
  id: string;
  path: string;
  size: number;
  received: number;
  create: boolean;
  updatedAt: number;
}

export interface SessionOptions {
  now?: () => number;
  /** Free bytes on the disk that holds `dir`; replaced in tests. */
  freeBytes?: (dir: string) => Promise<number>;
}

const defaultFreeBytes = async (dir: string): Promise<number> => {
  const disk = await statfs(dir);
  return disk.bavail * disk.bsize;
};

/**
 * Resumable uploads for files too big for one request. A file arrives in parts written straight
 * to `.palimvo/uploads/<id>/` (never held in memory) and is moved into the vault once complete.
 * Progress is kept on disk, so an upload survives a server restart and carries on after a dropped
 * connection from the byte the server says it has.
 */
export class UploadSessions {
  private readonly lock = new KeyedMutex();
  private readonly now: () => number;
  private readonly freeBytes: (dir: string) => Promise<number>;

  constructor(
    private readonly vaults: VaultService,
    options: SessionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.freeBytes = options.freeBytes ?? defaultFreeBytes;
  }

  /** Starts an upload of `size` bytes to `rel` (already checked by the policy). */
  async begin(vault: string, rel: string, size: number, create: boolean): Promise<UploadStatus> {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new AppError(
        "invalid_request",
        undefined,
        { size },
        { message: "size must be a whole number of bytes." },
      );
    if (size > MAX_CHUNKED_FILE_BYTES)
      throw new AppError("payload_too_large", undefined, { limit: MAX_CHUNKED_FILE_BYTES });
    const root = await this.vaults.internalDir(vault, DIR);
    await this.sweep(root);
    const open = (await readdir(root, { withFileTypes: true })).filter(
      (e) => e.isDirectory() && ID.test(e.name),
    ).length;
    if (open >= MAX_OPEN_UPLOADS) throw new AppError("upload_limit", undefined, { open });
    if ((await this.freeBytes(root)) < size + DISK_MARGIN_BYTES)
      throw new AppError("storage_full", undefined, { size });
    const id = randomBytes(16).toString("hex");
    const dir = path.join(root, id);
    await mkdir(dir);
    await writeFile(path.join(dir, "data"), new Uint8Array());
    const meta: UploadMeta = { id, path: rel, size, received: 0, create, updatedAt: this.now() };
    await this.save(dir, meta);
    return status(meta);
  }

  async status(vault: string, id: string): Promise<UploadStatus> {
    return status((await this.load(vault, id)).meta);
  }

  /**
   * Appends one part starting at `offset`, which must equal the number of bytes already received.
   * A part that breaks off is dropped as a whole; send it again from the same offset.
   */
  async part(
    vault: string,
    id: string,
    offset: number,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<UploadStatus> {
    return this.lock.run(id, async () => {
      const { dir, meta } = await this.load(vault, id);
      if (!Number.isSafeInteger(offset) || offset !== meta.received)
        throw new AppError("upload_offset", undefined, { expected: meta.received, got: offset });
      const room = Math.min(UPLOAD_PART_BYTES, meta.size - meta.received);
      const file = await open(path.join(dir, "data"), "r+");
      let written = 0;
      try {
        // Leftovers of a part that broke off earlier are cut away before writing.
        await file.truncate(meta.received);
        if (body) {
          const reader = body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (written + value.byteLength > room) {
              await reader.cancel().catch(() => undefined);
              throw new AppError("payload_too_large", undefined, {
                limit: UPLOAD_PART_BYTES,
                remaining: meta.size - meta.received,
              });
            }
            await file.write(value, 0, value.byteLength, meta.received + written);
            written += value.byteLength;
          }
        }
        if (written === 0 && meta.received < meta.size)
          throw new AppError("invalid_request", undefined, {}, { message: "The part is empty." });
        await file.sync();
      } catch (err) {
        await file.truncate(meta.received).catch(() => undefined);
        throw err;
      } finally {
        await file.close();
      }
      const next = { ...meta, received: meta.received + written, updatedAt: this.now() };
      await this.save(dir, next);
      return status(next);
    });
  }

  /** Hands the finished file to `place` (which moves it into the vault) and forgets the upload. */
  async finish<T>(
    vault: string,
    id: string,
    place: (source: string, meta: UploadMeta) => Promise<T>,
  ): Promise<T> {
    return this.lock.run(id, async () => {
      const { dir, meta } = await this.load(vault, id);
      if (meta.received !== meta.size)
        throw new AppError("upload_incomplete", undefined, {
          received: meta.received,
          size: meta.size,
        });
      const saved = await place(path.join(dir, "data"), meta);
      await rm(dir, { recursive: true, force: true });
      return saved;
    });
  }

  async cancel(vault: string, id: string): Promise<void> {
    await this.lock.run(id, async () => {
      const { dir } = await this.load(vault, id);
      await rm(dir, { recursive: true, force: true });
    });
  }

  private async load(vault: string, id: string): Promise<{ dir: string; meta: UploadMeta }> {
    if (!ID.test(id)) throw notFound();
    const dir = path.join(await this.vaults.internalDir(vault, DIR), id);
    const meta = await readFile(path.join(dir, "meta.json"), "utf8").then(
      (t) => JSON.parse(t) as UploadMeta,
      () => null,
    );
    if (!meta || meta.id !== id) throw notFound();
    if (this.now() - meta.updatedAt > UPLOAD_IDLE_MS) {
      await rm(dir, { recursive: true, force: true });
      throw notFound("This upload expired; start it again.");
    }
    return { dir, meta };
  }

  private async save(dir: string, meta: UploadMeta): Promise<void> {
    const temp = path.join(dir, `meta.json.${randomBytes(4).toString("hex")}`);
    await writeFile(temp, JSON.stringify(meta));
    await rename(temp, path.join(dir, "meta.json"));
  }

  /** Removes uploads nobody added to for a day, and folders left half-made. */
  private async sweep(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      await this.lock.run(entry.name, async () => {
        const dir = path.join(root, entry.name);
        const meta = await readFile(path.join(dir, "meta.json"), "utf8").then(
          (t) => JSON.parse(t) as UploadMeta,
          () => null,
        );
        const touched =
          meta?.updatedAt ??
          (await stat(dir).then(
            (s) => s.mtimeMs,
            () => 0,
          ));
        if (this.now() - touched > UPLOAD_IDLE_MS) await rm(dir, { recursive: true, force: true });
      });
    }
  }
}

function notFound(
  message = "No such upload (it may have finished, been cancelled or expired).",
): AppError {
  return new AppError("not_found", undefined, {}, { message });
}

function status(meta: UploadMeta): UploadStatus {
  return {
    id: meta.id,
    path: meta.path,
    size: meta.size,
    received: meta.received,
    partBytes: UPLOAD_PART_BYTES,
  };
}
