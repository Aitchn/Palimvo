import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  InvalidPathError,
  VAULT_META_DIR,
  fileKind,
  isTextDocument,
  isValidVaultId,
  normalizeVaultPath,
  pathKey,
  type FileContent,
  type TreeNode,
  type VaultInfo,
} from "@palimvo/core";
import { errorFields } from "../errors.ts";
import type { Logger } from "../log.ts";
import { cacheKey, VaultCaches, type VaultCache } from "./cache.ts";
import {
  MAX_TEXT_BYTES,
  TEMP_FILE,
  atomicWrite,
  bytesVersion,
  errnoCode,
  exists,
  isDirectory,
  isMissing,
  mapFsError,
  readBytesIfExists,
  readIfExists,
  realpathOfNearestExisting,
  renameRetrying,
  tempName,
  writeTemp,
} from "./fsutil.ts";
import { SharedExclusiveMutex } from "./mutex.ts";
import { migrateLegacyMeta, newVaultConfig, VAULT_CONFIG_FILE } from "./meta.ts";

/**
 * A file in a vault was written, deleted or moved (by anyone). `path` is the new path for a move.
 * An external change may name a folder (or "" for the whole vault): anything below it may have changed.
 */
export interface VaultChange {
  vault: string;
  type: "changed" | "deleted" | "moved" | "removed";
  path: string;
  from?: string;
  /** Reported by the file watcher: a change made outside the app (an editor, git, a sync tool), or the echo of the app's own write. */
  external?: boolean;
}

/** Hooks other subsystems register to follow what the file layer does (e.g. history). */
export interface VaultHooks {
  /** A vault's `.aivault/` folder was renamed to `.palimvo/`; version history should record that. */
  legacyMetaRenamed?(vault: string): void | Promise<void>;
}

export interface VaultServiceOptions {
  logger: Logger;
  cache?: { enabled?: boolean; maxBytes?: number };
  hooks?: VaultHooks;
}

/** One file of a batch. `baseVersion` is the version it must still have (`null`: it must not exist). */
export type BatchWrite = { path: string; baseVersion: string | null } & (
  { content: string } | { bytes: Uint8Array }
);

export interface WriteResult {
  path: string;
  size: number;
  mtime: number;
  version: string;
}

export const MAX_BATCH_FILES = 500;
export const MAX_BATCH_BYTES = 100 * 1024 * 1024;

/** Keeps an otherwise empty folder in git; hidden like every dot-file. */
const FOLDER_PLACEHOLDER = ".gitkeep";

const WELCOME_NOTE = `# Welcome

This is your new vault.

- Link notes together with [[wikilinks]]
- Use the file tree on the left to create notes and folders
`;

/**
 * Every read and write of vault files goes through here, so path safety, atomic writes,
 * optimistic versions and per-vault write ordering are enforced in one place.
 */
export class VaultService {
  /**
   * Writes of single files run in parallel with writes of other files (one at a time per file);
   * everything that touches several paths or must see the vault standing still (batches, moves,
   * deletes, history snapshots) runs alone.
   */
  private readonly writes = new SharedExclusiveMutex();
  private readonly listeners = new Set<(change: VaultChange) => void>();
  /** Vaults being removed: already gone for every new request while the removal finishes. */
  private readonly removing = new Set<string>();
  /** Per vault, the one-time checks done before it is first used. */
  private readonly opened = new Map<string, Promise<void>>();
  private readonly trees = new WeakMap<readonly TreeNode[], string>();
  private readonly cache: VaultCaches;
  private readonly log: Logger;
  private closed = false;

  constructor(
    readonly root: string,
    private readonly options: VaultServiceOptions,
  ) {
    this.log = options.logger;
    this.cache = new VaultCaches(options.logger, options.cache);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Waits for queued writes to finish; used during graceful shutdown. */
  idle(): Promise<void> {
    return this.writes.idle();
  }

  /** Stops watching every vault. Call after `idle()`. */
  close(): void {
    this.closed = true;
    this.cache.closeAll();
  }

  /** Calls `listener` after every change; returns a function that stops it. */
  onChange(listener: (change: VaultChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tells listeners about a change; also used by other subsystems for changes they make. */
  emit(change: VaultChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        // A broken listener must not fail the write that triggered it.
        this.log.error("vault change listener failed", {
          vault: change.vault,
          ...errorFields(err),
        });
      }
    }
  }

  private vaultKey(vault: string): string {
    return process.platform === "win32" ? vault.toLowerCase() : vault;
  }

  private queueWrite<T>(vault: string, change: () => Promise<T>): Promise<T> {
    return this.writes.exclusive(this.vaultKey(vault), change);
  }

  /** Like `queueWrite` for a change to one file (`key`), which may run alongside changes to other files. */
  private queueFileWrite<T>(vault: string, key: string, change: () => Promise<T>): Promise<T> {
    return this.writes.shared(this.vaultKey(vault), cacheKey(key), change);
  }

  /**
   * Runs `fn` with the vault's write queue held, so no file in it changes meanwhile (used to
   * snapshot the vault for a history commit).
   */
  exclusive<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
    return this.queueWrite(vaultId, fn);
  }

  // ---- vaults -------------------------------------------------------------------------------

  /** Throws `vault_not_found` unless the vault exists (and opens it the first time). */
  async assertVault(vaultId: string): Promise<void> {
    await this.vaultDir(vaultId);
  }

  async listVaults(): Promise<VaultInfo[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && isValidVaultId(e.name) && !this.removing.has(e.name))
      .map((e) => ({ id: e.name, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates the vault folder with its settings and a welcome note. */
  async createVault(id: string): Promise<VaultInfo> {
    if (!isValidVaultId(id)) {
      throw new AppError(
        "invalid_request",
        undefined,
        { vault: id },
        { message: `Invalid vault id "${id}".` },
      );
    }
    return this.queueWrite(id, async () => {
      if (this.removing.has(id)) throw new AppError("vault_busy", undefined, { vault: id });
      const dir = path.join(this.root, id);
      try {
        await mkdir(dir);
      } catch (err) {
        if (errnoCode(err) === "EEXIST")
          throw new AppError("already_exists", undefined, { vault: id });
        throw err;
      }
      await mkdir(path.join(dir, VAULT_META_DIR));
      await atomicWrite(
        path.join(dir, VAULT_META_DIR, VAULT_CONFIG_FILE),
        JSON.stringify(newVaultConfig(), null, 2) + "\n",
      );
      await atomicWrite(path.join(dir, "Welcome.md"), WELCOME_NOTE);
      this.opened.set(this.vaultKey(id), Promise.resolve());
      return { id, name: id };
    });
  }

  /**
   * Starts removing a vault: from now on it is not listed and every request for it gets "not
   * found". Until `archiveVault` moves it away (or `cancelRemoval`), its folder stays put.
   * False if it is already being removed.
   */
  beginRemoval(id: string): boolean {
    if (this.removing.has(id)) return false;
    this.removing.add(id);
    return true;
  }

  cancelRemoval(id: string): void {
    this.removing.delete(id);
  }

  /** Moves a vault's folder to `dest` (outside the served vaults) once queued writes to it have finished. Needs `beginRemoval` first. */
  async archiveVault(id: string, dest: string): Promise<void> {
    if (!this.removing.has(id)) throw new Error(`archiveVault("${id}") without beginRemoval`);
    const dir = path.join(this.root, id);
    await this.queueWrite(id, async () => {
      // Stop watching first: Windows cannot rename a folder that is being watched.
      this.cache.drop(this.vaultKey(id));
      await mkdir(path.dirname(dest), { recursive: true });
      await renameRetrying(dir, dest);
    });
    this.opened.delete(this.vaultKey(id));
    this.removing.delete(id);
    this.emit({ vault: id, type: "removed", path: "" });
  }

  /** Puts an archived vault folder back as vault `id`. */
  async restoreVault(src: string, id: string): Promise<void> {
    if (!isValidVaultId(id)) {
      throw new AppError(
        "invalid_request",
        undefined,
        { vault: id },
        { message: `Invalid vault id "${id}".` },
      );
    }
    const dir = path.join(this.root, id);
    await this.queueWrite(id, async () => {
      if (this.removing.has(id) || (await exists(dir)))
        throw new AppError("already_exists", undefined, { vault: id });
      this.cache.drop(this.vaultKey(id));
      await renameRetrying(src, dir);
    });
  }

  // ---- reading ------------------------------------------------------------------------------

  /** The vault's folders and files. The result is shared and frozen: copy it before changing it. */
  async tree(vaultId: string): Promise<readonly TreeNode[]> {
    const cached = this.cached(vaultId)?.tree;
    if (cached) return cached.nodes;
    const dir = await this.vaultDir(vaultId);
    const cache = this.cacheFor(vaultId);
    const stamp = cache?.begin() ?? 0;
    try {
      const nodes = await this.walk(dir, "");
      if (cache && !cache.warmed) {
        cache.warmed = true;
        void this.warm(vaultId, nodes);
      }
      return cache ? cache.fillTree(nodes, stamp) : nodes;
    } finally {
      cache?.end();
    }
  }

  /** A short identifier of which files and folders exist (not their content), for `ETag`. */
  async treeTag(vaultId: string): Promise<string> {
    const nodes = await this.tree(vaultId);
    let tag = this.trees.get(nodes);
    if (!tag) {
      const hash = createHash("sha1");
      const visit = (list: readonly TreeNode[]) => {
        for (const node of list) {
          hash.update(`${node.type[0]}${node.path}\0`);
          if (node.children) visit(node.children);
        }
      };
      visit(nodes);
      tag = hash.digest("hex").slice(0, 16);
      this.trees.set(nodes, tag);
    }
    return tag;
  }

  /** Flat list of every visible file path in the vault (shared and frozen, like `tree`). */
  async listFiles(vaultId: string): Promise<readonly string[]> {
    const nodes = await this.tree(vaultId);
    const cached = this.cached(vaultId)?.tree;
    if (cached?.nodes === nodes) return cached.files;
    const files: string[] = [];
    const collect = (list: readonly TreeNode[]) => {
      for (const node of list) {
        if (node.type === "file") files.push(node.path);
        else if (node.children) collect(node.children);
      }
    };
    collect(nodes);
    return Object.freeze(files);
  }

  /**
   * A file's text. Served from memory when it has not changed since it was last read; `fresh`
   * always reads the disk (for callers that look for changes made outside the app).
   */
  async readFile(
    vaultId: string,
    filePath: string,
    options: { fresh?: boolean } = {},
  ): Promise<FileContent> {
    const rel = normalize(filePath);
    const hit = options.fresh ? undefined : this.cached(vaultId)?.get(cacheKey(rel));
    if (hit) return hit.path === rel ? hit : { ...hit, path: rel };
    // Every disk read re-checks where the path really leads (a folder may have become a symlink).
    const { abs, rel: resolved, direct } = await this.resolve(vaultId, filePath);
    // Only files reached without a symlink are cached: their invalidations name the same path.
    const cache = direct ? this.cacheFor(vaultId) : undefined;
    const stamp = cache?.begin() ?? 0;
    try {
      const file = await readIfExists(abs, resolved);
      if (!file) throw new AppError("not_found", undefined, { path: resolved });
      return cache ? cache.fill(cacheKey(resolved), file, stamp) : file;
    } finally {
      cache?.end();
    }
  }

  /** The file if it is in memory and unchanged, without touching the disk (undefined otherwise). */
  cachedFile(vaultId: string, filePath: string): FileContent | undefined {
    const cache = this.cached(vaultId);
    if (!cache) return undefined;
    // Cache keys are normalized paths, so a hit on the path as given needs no normalizing
    // (this runs once per file in every search).
    let rel = filePath;
    let hit = cache.get(cacheKey(rel));
    if (!hit) {
      try {
        rel = normalizeVaultPath(filePath);
      } catch {
        return undefined;
      }
      hit = cache.get(cacheKey(rel));
    }
    return hit && hit.path !== rel ? { ...hit, path: rel } : hit;
  }

  // ---- writing ------------------------------------------------------------------------------

  /**
   * Writes a text file atomically. With `baseVersion` the write only happens if the file is
   * still at that version (`null` = it must not exist yet); otherwise a `version_conflict`
   * error carries the current content. Without it the file is overwritten. `onWritten` runs
   * while the write queue is still held (so history can record who wrote before it snapshots).
   */
  async writeFile(
    vaultId: string,
    filePath: string,
    content: string,
    options: { baseVersion?: string | null; onWritten?: (file: FileContent) => void } = {},
  ): Promise<FileContent> {
    const rel = normalize(filePath);
    if (fileKind(rel) === "other" && !isTextDocument(rel)) {
      throw new AppError("unsupported_type", undefined, { path: rel });
    }
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      throw new AppError("payload_too_large", undefined, { path: rel, limit: MAX_TEXT_BYTES });
    }
    const { onWritten } = options;
    const written = await this.putFile(
      vaultId,
      filePath,
      bytes,
      options.baseVersion,
      onWritten &&
        ((r) => onWritten({ path: r.path, content, mtime: r.mtime, version: r.version })),
    );
    return { path: written.path, content, mtime: written.mtime, version: written.version };
  }

  /**
   * Writes binary content atomically with the same version rules as `writeFile`. What file types
   * may be stored is decided by the caller (uploads), not here.
   */
  async writeBytes(
    vaultId: string,
    filePath: string,
    bytes: Uint8Array,
    options: { baseVersion?: string | null; onWritten?: (result: WriteResult) => void } = {},
  ): Promise<WriteResult> {
    return this.putFile(vaultId, filePath, bytes, options.baseVersion, options.onWritten);
  }

  private async putFile(
    vaultId: string,
    filePath: string,
    bytes: Uint8Array,
    baseVersion: string | null | undefined,
    onWritten?: (result: WriteResult) => void,
  ): Promise<WriteResult> {
    const { abs, rel, lock } = await this.resolve(vaultId, filePath);
    return this.queueFileWrite(vaultId, lock, () =>
      this.afterwards(vaultId, [rel, lock], async () => {
        const current = await readCurrent(abs, rel);
        if (baseVersion !== undefined && (current?.version ?? null) !== baseVersion) {
          throw this.conflict(rel, current);
        }
        if (await isDirectory(abs)) throw new AppError("already_exists", undefined, { path: rel });
        try {
          await mkdir(path.dirname(abs), { recursive: true });
          await atomicWrite(abs, bytes);
        } catch (err) {
          throw mapFsError(err, rel);
        }
        const info = await stat(abs);
        const result = {
          path: rel,
          size: bytes.byteLength,
          mtime: info.mtimeMs,
          version: bytesVersion(bytes),
        };
        onWritten?.(result);
        this.emit({ vault: vaultId, type: "changed", path: rel });
        return result;
      }),
    );
  }

  /**
   * Writes several files as one unit: every version is checked before anything changes, and if
   * installing one file fails the others are put back. A crash in the middle of installing can
   * still leave some files written (each file on its own is always whole).
   */
  async writeBatch(
    vaultId: string,
    changes: readonly BatchWrite[],
    options: { onWritten?: (results: WriteResult[]) => void } = {},
  ): Promise<WriteResult[]> {
    if (changes.length === 0) return [];
    if (changes.length > MAX_BATCH_FILES) {
      throw new AppError("payload_too_large", undefined, { limit: MAX_BATCH_FILES, what: "files" });
    }
    await this.opening(vaultId);
    return this.queueWrite(vaultId, () =>
      this.afterwards(
        vaultId,
        changes.map((c) => c.path),
        async () => {
          const results = await this.writeBatchLocked(vaultId, changes);
          options.onWritten?.(results);
          return results;
        },
      ),
    );
  }

  private async writeBatchLocked(
    vaultId: string,
    changes: readonly BatchWrite[],
  ): Promise<WriteResult[]> {
    await this.vaultDir(vaultId); // fails for an unknown vault before anything is staged
    interface Target {
      abs: string;
      rel: string;
      bytes: Uint8Array;
      old: Buffer | null;
      temp: string;
      installed: boolean;
    }
    const targets: Target[] = [];
    const seen: string[] = [];
    let total = 0;
    for (const change of changes) {
      const { abs, rel } = await this.resolve(vaultId, change.path);
      const key = pathKey(rel);
      if (seen.some((s) => s === key || s.startsWith(`${key}/`) || key.startsWith(`${s}/`))) {
        throw new AppError(
          "invalid_request",
          undefined,
          { path: rel },
          { message: `"${rel}" appears twice or overlaps another path in the batch.` },
        );
      }
      seen.push(key);
      const text = "content" in change;
      if (text && fileKind(rel) === "other" && !isTextDocument(rel)) {
        throw new AppError("unsupported_type", undefined, { path: rel });
      }
      const bytes = text ? Buffer.from(change.content, "utf8") : change.bytes;
      total += bytes.byteLength;
      if (total > MAX_BATCH_BYTES) {
        throw new AppError("payload_too_large", undefined, {
          limit: MAX_BATCH_BYTES,
          what: "bytes",
        });
      }
      if (await isDirectory(abs)) throw new AppError("already_exists", undefined, { path: rel });
      const old = await readBytesIfExists(abs);
      const current: FileContent | null = old
        ? { path: rel, content: "", mtime: old.mtime, version: bytesVersion(old.bytes) }
        : null;
      if ((current?.version ?? null) !== change.baseVersion) {
        throw this.conflict(
          rel,
          text && old ? await readIfExists(abs, rel) : null,
          current?.version,
        );
      }
      targets.push({
        abs,
        rel,
        bytes,
        old: old?.bytes ?? null,
        temp: tempName(abs),
        installed: false,
      });
    }

    const createdFolders: string[] = [];
    const cleanup = async () => {
      for (const t of targets) if (!t.installed) await unlink(t.temp).catch(() => undefined);
      for (const folder of createdFolders) await removeEmptyTree(folder);
    };
    try {
      for (const t of targets) {
        const first = await mkdir(path.dirname(t.abs), { recursive: true }).catch((err) => {
          throw mapFsError(err, t.rel);
        });
        if (first) createdFolders.push(first);
        await writeTemp(t.temp, t.bytes);
      }
      for (const t of targets) {
        // Nothing may have changed the file since it was checked: the vault queue is held, but
        // other programs are not bound by it.
        const now = await readBytesIfExists(t.abs);
        if ((now ? bytesVersion(now.bytes) : null) !== (t.old ? bytesVersion(t.old) : null)) {
          throw this.conflict(t.rel, await readIfExists(t.abs, t.rel));
        }
        await renameRetrying(t.temp, t.abs).catch((err) => {
          throw mapFsError(err, t.rel);
        });
        t.installed = true;
      }
    } catch (err) {
      for (const t of targets.filter((x) => x.installed).reverse()) {
        try {
          if (t.old) await atomicWrite(t.abs, t.old);
          else await unlink(t.abs);
        } catch (restoreError) {
          this.log.error("could not put a file back after a failed batch", {
            vault: vaultId,
            path: t.rel,
            ...errorFields(restoreError),
          });
        }
      }
      await cleanup();
      throw err;
    }
    const results: WriteResult[] = [];
    for (const t of targets) {
      const info = await stat(t.abs);
      results.push({
        path: t.rel,
        size: t.bytes.byteLength,
        mtime: info.mtimeMs,
        version: bytesVersion(t.bytes),
      });
      this.emit({ vault: vaultId, type: "changed", path: t.rel });
    }
    return results;
  }

  /**
   * Creates an empty folder. Git does not keep empty folders, so it holds a hidden `.gitkeep`
   * (never shown in the tree) to survive history and backups. `onDone` gets the placeholder's
   * path while the write queue is still held.
   */
  async createFolder(
    vaultId: string,
    folderPath: string,
    onDone?: (path: string) => void,
  ): Promise<{ path: string }> {
    const { abs, rel } = await this.resolve(vaultId, folderPath);
    return this.queueWrite(vaultId, () =>
      this.afterwards(
        vaultId,
        [rel],
        async () => {
          if (await exists(abs)) throw new AppError("already_exists", undefined, { path: rel });
          try {
            await mkdir(abs, { recursive: true });
            await atomicWrite(path.join(abs, FOLDER_PLACEHOLDER), "");
          } catch (err) {
            throw mapFsError(err, rel);
          }
          onDone?.(`${rel}/${FOLDER_PLACEHOLDER}`);
          this.emit({ vault: vaultId, type: "changed", path: rel });
          return { path: rel };
        },
        true,
      ),
    );
  }

  /**
   * Deletes a file, or a folder with everything in it. `onDone` gets every file removed and runs
   * while the write queue is still held (see `exclusive`).
   */
  async deleteFile(
    vaultId: string,
    filePath: string,
    onDone?: (paths: string[]) => void,
  ): Promise<void> {
    const { abs, rel } = await this.resolve(vaultId, filePath);
    await this.queueWrite(vaultId, () =>
      this.afterwards(
        vaultId,
        [rel],
        async () => {
          let files: string[];
          try {
            files = await filesUnder(abs, rel);
          } catch (err) {
            throw mapFsError(err, rel);
          }
          await rm(abs, { recursive: true });
          onDone?.(files);
          this.emit({ vault: vaultId, type: "deleted", path: rel });
        },
        true,
      ),
    );
  }

  /**
   * Moves or renames a file or a folder. `onDone` gets every file's old and new path and runs
   * while the write queue is still held.
   */
  async move(
    vaultId: string,
    from: string,
    to: string,
    onDone?: (moved: [from: string, to: string][]) => void,
  ): Promise<{ path: string }> {
    const src = await this.resolve(vaultId, from);
    const dest = await this.resolve(vaultId, to);
    const [a, b] = [pathKey(src.rel), pathKey(dest.rel)];
    if (b.startsWith(`${a}/`)) {
      throw new AppError(
        "invalid_request",
        undefined,
        { path: src.rel },
        { message: `Cannot move "${src.rel}" into itself.` },
      );
    }
    // Only the case differs ("Note.md" -> "note.md"): the same file on Windows and macOS.
    const recase = b === a && src.rel !== dest.rel;
    if (b === a && !recase) return { path: dest.rel };
    return this.queueWrite(vaultId, () =>
      this.afterwards(
        vaultId,
        [src.rel, dest.rel],
        async () => {
          let files: string[];
          try {
            files = await filesUnder(src.abs, src.rel);
          } catch (err) {
            throw mapFsError(err, src.rel);
          }
          if (recase) {
            // A case-sensitive system holds two different files; only a case-insensitive one makes this a rename.
            if (await sameFile(src.abs, dest.abs)) {
              const hop = tempName(src.abs);
              await renameRetrying(src.abs, hop);
              await renameRetrying(hop, dest.abs);
            } else {
              await this.moveInto(src.abs, dest.abs, dest.rel);
            }
          } else {
            await this.moveInto(src.abs, dest.abs, dest.rel);
          }
          onDone?.(files.map((f) => [f, dest.rel + f.slice(src.rel.length)]));
          this.emit({ vault: vaultId, type: "moved", path: dest.rel, from: src.rel });
          return { path: dest.rel };
        },
        true,
      ),
    );
  }

  private async moveInto(srcAbs: string, destAbs: string, destRel: string): Promise<void> {
    if (await exists(destAbs)) throw new AppError("already_exists", undefined, { path: destRel });
    try {
      await mkdir(path.dirname(destAbs), { recursive: true });
      await renameRetrying(srcAbs, destAbs);
    } catch (err) {
      throw mapFsError(err, destRel);
    }
  }

  // ---- the vault's own settings (.palimvo/) --------------------------------------------------

  /** A file in the vault's `.palimvo/` folder (never reachable through the file API), or null. `name` is chosen by the app, never by a client. */
  async readMeta(vaultId: string, name: string): Promise<string | null> {
    const abs = await this.metaPath(vaultId, name);
    try {
      return (await readIfExists(abs, name))?.content ?? null;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /** Writes a `.palimvo/` file atomically. `onWritten` runs while the write queue is still held. */
  async writeMeta(
    vaultId: string,
    name: string,
    content: string,
    onWritten?: () => void,
  ): Promise<void> {
    const abs = await this.metaPath(vaultId, name);
    await this.queueFileWrite(vaultId, `\0${name}`, async () => {
      await mkdir(path.dirname(abs), { recursive: true });
      await atomicWrite(abs, content);
      onWritten?.();
    });
  }

  private async metaPath(vaultId: string, name: string): Promise<string> {
    if (
      !/^[a-z0-9_-][a-z0-9_.-]*(\/[a-z0-9_.-]+)*$/i.test(name) ||
      name.split("/").includes("..")
    ) {
      throw new Error(`Invalid vault metadata name "${name}"`);
    }
    const dir = await this.vaultDir(vaultId);
    const meta = path.join(dir, VAULT_META_DIR);
    const info = await lstat(meta).catch(() => null);
    if (info?.isSymbolicLink()) {
      throw new AppError(
        "invalid_path",
        undefined,
        { path: VAULT_META_DIR },
        { message: "The vault settings folder cannot be a link." },
      );
    }
    return path.join(meta, ...name.split("/"));
  }

  // ---- internals ----------------------------------------------------------------------------

  /**
   * Runs once per vault before it is used: moves a legacy `.aivault/` folder to `.palimvo/` and
   * removes temp files an interrupted write left behind.
   */
  private opening(vaultId: string): Promise<void> {
    const key = this.vaultKey(vaultId);
    let opening = this.opened.get(key);
    if (!opening) {
      opening = this.open(vaultId).catch((err) => {
        this.opened.delete(key); // try again next time
        throw err;
      });
      this.opened.set(key, opening);
    }
    return opening;
  }

  private async open(vaultId: string): Promise<void> {
    const dir = path.join(this.root, vaultId);
    if (
      !(await stat(dir).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    )
      return;
    const renamed = await migrateLegacyMeta(dir, this.log);
    if (renamed) {
      const hook = this.options.hooks?.legacyMetaRenamed;
      // Not awaited: the hook may need this vault's write queue, which requests are waiting behind us to enter.
      if (hook)
        void Promise.resolve()
          .then(() => hook(vaultId))
          .catch((err) =>
            this.log.error("legacy meta hook failed", { vault: vaultId, ...errorFields(err) }),
          );
    }
    await removeStaleTempFiles(dir);
  }

  private async vaultDir(vaultId: string): Promise<string> {
    if (!isValidVaultId(vaultId) || this.removing.has(vaultId)) throw vaultNotFound(vaultId);
    const dir = path.join(this.root, vaultId);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) throw vaultNotFound(vaultId);
    await this.opening(vaultId);
    return dir;
  }

  /**
   * `direct`: the path leads to its file without passing through a symlink. `lock`: the file's
   * real vault-relative path, so writes through different spellings or symlinks share one lock.
   */
  private async resolve(
    vaultId: string,
    filePath: string,
  ): Promise<{ abs: string; rel: string; direct: boolean; lock: string }> {
    const dir = await this.vaultDir(vaultId);
    const rel = normalize(filePath);
    const abs = path.join(dir, ...rel.split("/"));
    const realRoot = await realpath(dir);
    const realTarget = await realpathOfNearestExisting(abs);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new AppError("not_found", undefined, { path: rel });
    }
    const lock = path.relative(realRoot, realTarget).split(path.sep).join("/");
    return {
      abs,
      rel,
      direct: cacheKey(realTarget) === cacheKey(path.join(realRoot, ...rel.split("/"))),
      lock,
    };
  }

  private conflict(rel: string, current: FileContent | null, currentVersion?: string): AppError {
    return new AppError("version_conflict", undefined, {
      path: rel,
      current,
      ...(currentVersion ? { currentVersion } : {}),
    });
  }

  private async walk(absDir: string, relDir: string): Promise<TreeNode[]> {
    const entries = await readdir(absDir, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: rel,
          type: "folder",
          children: await this.walk(path.join(absDir, entry.name), rel),
        });
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: rel, type: "file", kind: fileKind(rel) });
      }
    }
    return nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1,
    );
  }

  /**
   * Reads a vault's notes, canvases and bases into memory in the background the first time the
   * vault is opened, so the first search or database query does not have to wait for the disk.
   */
  private async warm(vaultId: string, nodes: readonly TreeNode[]): Promise<void> {
    const paths: string[] = [];
    const collect = (list: readonly TreeNode[]) => {
      for (const node of list) {
        if (node.type === "file" && fileKind(node.path) !== "other") paths.push(node.path);
        else if (node.children) collect(node.children);
      }
    };
    collect(nodes);
    for (let i = 0; i < paths.length; i += 8) {
      if (this.closed || !this.cache.peek(this.vaultKey(vaultId))) return; // closed, or dropped meanwhile (removed, watcher failed)
      await Promise.all(
        paths.slice(i, i + 8).map((p) => this.readFile(vaultId, p).catch(() => undefined)),
      );
    }
  }

  /** The vault's cache, started if needed; none while it is being removed (its folder must not be watched then). */
  private cacheFor(vaultId: string): VaultCache | undefined {
    if (this.removing.has(vaultId) || this.closed) return undefined;
    return this.cache.get(this.vaultKey(vaultId), path.join(this.root, vaultId), (paths) =>
      this.external(vaultId, paths),
    );
  }

  /** Tells listeners what changed outside the app (the cache has already dropped it). */
  private external(vaultId: string, paths: string[]): void {
    for (const p of paths) this.emit({ vault: vaultId, type: "changed", path: p, external: true });
  }

  /** The vault's cache when it may be used right now (a valid vault that is not being removed). */
  private cached(vaultId: string): VaultCache | undefined {
    if (!isValidVaultId(vaultId) || this.removing.has(vaultId)) return undefined;
    return this.cache.peek(this.vaultKey(vaultId));
  }

  /**
   * Runs a change to `paths` (files or folders) and then tells the cache they changed, whether
   * the change succeeded or not: a failed write may still have changed the disk.
   */
  private async afterwards<T>(
    vaultId: string,
    paths: readonly string[],
    change: () => Promise<T>,
    folder = false,
  ): Promise<T> {
    try {
      return await change();
    } finally {
      const cache = this.cache.peek(this.vaultKey(vaultId));
      if (cache) {
        for (const raw of paths) {
          let rel: string;
          try {
            rel = normalizeVaultPath(raw);
          } catch {
            continue;
          }
          cache.invalidate(rel, { structure: folder || !cache.knows(rel), folder });
        }
      }
    }
  }
}

function vaultNotFound(vaultId: string): AppError {
  return new AppError("vault_not_found", undefined, { vault: vaultId });
}

/** Normalizes a client path; a bad one becomes an `invalid_path` API error. */
function normalize(filePath: string): string {
  try {
    return normalizeVaultPath(filePath);
  } catch (err) {
    if (err instanceof InvalidPathError) {
      throw new AppError("invalid_path", undefined, { path: filePath }, { message: err.message });
    }
    throw err;
  }
}

/** Current content of a file as a conflict report needs it (text only); null if absent. */
async function readCurrent(abs: string, rel: string): Promise<FileContent | null> {
  const old = await readBytesIfExists(abs);
  if (!old) return null;
  return {
    path: rel,
    content: old.bytes.byteLength > MAX_TEXT_BYTES ? "" : old.bytes.toString("utf8"),
    mtime: old.mtime,
    version: bytesVersion(old.bytes),
  };
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  return !!x && !!y && x.ino === y.ino && x.dev === y.dev && x.ino !== 0;
}

/** `rel` itself if it is a file, else every file below it (hidden ones too), as vault-relative paths. */
async function filesUnder(abs: string, rel: string): Promise<string[]> {
  const info = await stat(abs);
  if (!info.isDirectory()) return [rel];
  const files: string[] = [];
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory())
      files.push(...(await filesUnder(path.join(abs, entry.name), childRel)));
    else files.push(childRel);
  }
  return files;
}

/** Removes `folder` and every folder below it, but only the empty ones: a file anywhere keeps its folders. */
async function removeEmptyTree(folder: string): Promise<boolean> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => null);
  if (!entries) return false;
  let empty = true;
  for (const entry of entries) {
    if (!entry.isDirectory() || !(await removeEmptyTree(path.join(folder, entry.name))))
      empty = false;
  }
  if (!empty) return false;
  return rmdir(folder).then(
    () => true,
    () => false,
  );
}

/** Temp files from a write interrupted by a crash; the real file is still intact. */
async function removeStaleTempFiles(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== ".git") await removeStaleTempFiles(abs);
    else if (entry.isFile() && TEMP_FILE.test(entry.name)) await unlink(abs).catch(() => undefined);
  }
}
