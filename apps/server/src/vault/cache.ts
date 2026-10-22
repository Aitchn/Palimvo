import { readdirSync, watch, type FSWatcher } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FileContent, TreeNode } from "@palimvo/core";
import { errorFields } from "../errors.ts";
import type { Logger } from "../log.ts";

/** Text files larger than this are always read from disk instead of being kept in memory. */
const MAX_CACHED_FILE_BYTES = 2 * 1024 * 1024;
/** Total size of cached file contents across all vaults (oldest-used dropped first). */
export const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024;
/** After the watcher fails, caching stays off for the vault this long before it tries again. */
const WATCH_RETRY_MS = 60_000;
/**
 * How often cached files are checked against the disk anyway, in case a change slipped past the
 * watcher (some network or container file systems do not report every change).
 */
const SWEEP_MS = 60_000;

/** Windows and macOS file systems ignore case: "Note.md" and "note.md" are one file. */
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
export const cacheKey = (rel: string): string => (CASE_INSENSITIVE ? rel.toLowerCase() : rel);

interface FileEntry {
  file: FileContent;
  bytes: number;
}

/**
 * What one vault's files look like, kept in memory so reading the file tree, searching or
 * collecting every note does not have to walk the disk and reopen every file each time.
 *
 * Correctness rules:
 * - The service invalidates paths itself after every write it makes (after the disk changed).
 * - A recursive file watcher invalidates whatever changes outside the app (people editing files
 *   directly, git, sync tools). If the watcher cannot run, nothing is cached for the vault.
 * - A read that started before an invalidation of its path never fills the cache with what it read.
 */
class VaultCache {
  tree?: { nodes: readonly TreeNode[]; files: readonly string[]; known: Set<string> };
  readonly files = new Map<string, FileEntry>();
  /** Whether the vault's notes were already read into memory once. */
  warmed = false;
  /** Bumped by every invalidation. */
  private epoch = 0;
  /** Epoch of the last invalidation of each path (forgotten when no read is in flight). */
  private readonly invalidated = new Map<string, number>();
  /** Folder prefix ("a/b/") -> epoch of its last invalidation (forgotten like `invalidated`). */
  private readonly folders = new Map<string, number>();
  /** Epoch of the last invalidation of everything (an overflow, a failed rollback). */
  private broadEpoch = 0;
  /** Epoch of the last change to which files and folders exist. */
  private structureEpoch = 0;
  private inflight = 0;
  private watcher?: { close(): void };
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private pending = new Set<string | null>();
  private flushing = false;

  constructor(
    readonly dir: string,
    private readonly owner: CacheStore,
    private readonly onBroken: () => void,
    private readonly log: Logger,
    private readonly onExternal: (paths: string[]) => void,
  ) {}

  /** Starts watching the vault folder; false if this platform or folder cannot be watched. */
  start(): boolean {
    let broken = false;
    const failed = (err: unknown) => {
      broken = true;
      this.log.warn("vault watcher failed; reading from disk until it restarts", {
        dir: this.dir,
        ...watchFailure(err),
      });
      this.onBroken();
    };
    try {
      this.watcher = watchVault(this.dir, (rel) => this.queue(rel), failed);
    } catch (err) {
      this.log.warn("cannot watch vault folder; reading from disk", {
        dir: this.dir,
        ...watchFailure(err),
      });
      return false;
    }
    if (broken) {
      // Failed while starting (e.g. no inotify watches left): the caller registers nothing.
      this.watcher.close();
      this.watcher = undefined;
      return false;
    }
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
    return true;
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.sweepTimer);
    this.invalidateAll();
  }

  /** Safety net: drops cached files whose modification time changed and a file list that differs from the disk. */
  private async sweep(): Promise<void> {
    if (this.sweeping || !this.watcher) return;
    this.sweeping = true;
    try {
      const entries = [...this.files.entries()];
      for (let i = 0; i < entries.length; i += 64) {
        await Promise.all(
          entries.slice(i, i + 64).map(async ([key, entry]) => {
            const info = await stat(path.join(this.dir, ...entry.file.path.split("/"))).catch(
              () => null,
            );
            if (this.files.get(key) === entry && info?.mtimeMs !== entry.file.mtime)
              this.invalidate(entry.file.path, { structure: !info, folder: false });
          }),
        );
      }
      const tree = this.tree;
      if (tree) {
        const onDisk = await listFiles(this.dir);
        if (
          this.tree === tree &&
          (onDisk.length !== tree.files.length || onDisk.some((f) => !tree.known.has(cacheKey(f))))
        ) {
          this.invalidate("", { structure: true, folder: false });
        }
      }
    } catch (err) {
      this.log.warn("vault cache check failed", { dir: this.dir, ...errorFields(err) });
    } finally {
      this.sweeping = false;
    }
  }

  /** Marks the start of a disk read whose result may be cached; pass the stamp to `fill`/`fillTree`. */
  begin(): number {
    this.inflight++;
    return this.epoch;
  }

  end(): void {
    if (--this.inflight === 0) {
      this.invalidated.clear();
      this.folders.clear();
    }
  }

  fill(key: string, file: FileContent, stamp: number): FileContent {
    const bytes = file.content.length * 2;
    if (
      bytes > MAX_CACHED_FILE_BYTES ||
      this.broadEpoch > stamp ||
      (this.invalidated.get(key) ?? 0) > stamp
    )
      return file;
    for (const [prefix, epoch] of this.folders)
      if (epoch > stamp && key.startsWith(prefix)) return file;
    const frozen = Object.freeze({ ...file });
    const old = this.files.get(key);
    if (old) this.owner.release(old.bytes);
    this.files.set(key, { file: frozen, bytes });
    this.owner.use(this, key, bytes);
    return frozen;
  }

  get(key: string): FileContent | undefined {
    const entry = this.files.get(key);
    if (!entry) return undefined;
    this.owner.touch(this, key);
    return entry.file;
  }

  fillTree(nodes: TreeNode[], stamp: number): readonly TreeNode[] {
    const files: string[] = [];
    const collect = (list: TreeNode[]) => {
      for (const node of list) {
        if (node.type === "file") files.push(node.path);
        else if (node.children) collect(node.children);
        Object.freeze(node);
      }
      Object.freeze(list);
    };
    collect(nodes);
    if (this.structureEpoch <= stamp && this.broadEpoch <= stamp) {
      this.tree = { nodes, files: Object.freeze(files), known: new Set(files.map(cacheKey)) };
    }
    return nodes;
  }

  /**
   * `rel` changed on disk. `structure`: files or folders may have appeared or gone (false when
   * only an existing file's content changed). `folder`: `rel` is (or may be) a folder, so
   * everything below it is stale too.
   */
  invalidate(rel: string, { structure, folder }: { structure: boolean; folder: boolean }): void {
    const key = cacheKey(rel);
    this.epoch++;
    this.invalidated.set(key, this.epoch);
    this.drop(key);
    if (folder) {
      const prefix = `${key}/`;
      this.folders.set(prefix, this.epoch);
      for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.drop(k);
    }
    if (structure || folder) {
      this.structureEpoch = this.epoch;
      this.tree = undefined;
    }
  }

  /** Whether the cached tree lists `rel` as a file. */
  knows(rel: string): boolean {
    return !!this.tree?.known.has(cacheKey(rel));
  }

  /** Forget everything (e.g. after a failed transaction rollback or a watcher overflow). */
  invalidateAll(): void {
    this.epoch++;
    this.broadEpoch = this.epoch;
    this.structureEpoch = this.epoch;
    this.tree = undefined;
    for (const key of [...this.files.keys()]) this.drop(key);
  }

  drop(key: string): void {
    const entry = this.files.get(key);
    if (!entry) return;
    this.files.delete(key);
    this.owner.release(entry.bytes);
    this.owner.forget(this, key);
  }

  /** Watcher events arrive in bursts (a git checkout, a sync); handle them together. */
  private queue(name: string | null): void {
    this.pending.add(name);
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => void this.flush());
  }

  private async flush(): Promise<void> {
    const names = [...this.pending];
    this.pending.clear();
    this.flushing = false;
    if (names.includes(null) || names.length > 1000) {
      this.invalidateAll();
      this.onExternal([""]);
      return;
    }
    for (const name of names as string[]) {
      if (!this.knows(name)) {
        // Not a known file: the file list changes. Only a folder (or something gone, which may
        // have been one) makes everything below it stale too.
        const info = await lstat(path.join(this.dir, ...name.split("/"))).catch(() => null);
        this.invalidate(name, { structure: true, folder: !info?.isFile() });
        continue;
      }
      // A known file changed: its content is stale, and the file list too if it is gone now.
      this.invalidate(name, { structure: false, folder: false });
      const info = await lstat(path.join(this.dir, ...name.split("/"))).catch(() => null);
      if (!info?.isFile()) this.invalidate(name, { structure: true, folder: true });
    }
    this.onExternal(names as string[]);
  }
}

/** Watcher failures that have a known fix get it spelled out in the log. */
function watchFailure(err: unknown): Record<string, unknown> {
  const fields = errorFields(err);
  return (err as NodeJS.ErrnoException)?.code === "ENOSPC"
    ? { ...fields, hint: "the system is out of file watches; raise fs.inotify.max_user_watches" }
    : fields;
}

/** Hidden names (.git, .aivault, temp files) are never shown, cached or watched. */
const hidden = (rel: string) => rel.split("/").some((part) => part.startsWith("."));

/**
 * Calls `onChange` with the vault-relative path of whatever changes below `dir` (null: unknown,
 * assume everything). Windows and macOS watch a whole tree natively. Elsewhere (Linux) Node's
 * recursive mode polls every file, which slows the whole server down in a large vault, so each
 * visible folder gets its own (inotify) watcher instead.
 */
function watchVault(
  dir: string,
  onChange: (rel: string | null) => void,
  onError: (err: unknown) => void,
): { close(): void } {
  if (process.platform === "win32" || process.platform === "darwin") {
    const watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
      const rel = filename === null ? null : filename.toString().split(path.sep).join("/");
      if (rel === null || !hidden(rel)) onChange(rel);
    });
    watcher.on("error", onError);
    return watcher;
  }
  return new FolderWatchers(dir, onChange, onError);
}

/** One non-recursive watcher per visible folder, following folders as they come and go. */
class FolderWatchers {
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly onChange: (rel: string | null) => void,
    private readonly onError: (err: unknown) => void,
  ) {
    this.add("");
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  /** Watches `rel` and every visible folder below it (synchronously, so nothing changes unseen meanwhile). */
  private add(rel: string): void {
    if (this.closed || this.watchers.has(rel)) return;
    const abs = path.join(this.root, ...rel.split("/").filter(Boolean));
    let watcher: FSWatcher;
    try {
      watcher = watch(abs, { persistent: false }, (_event, name) =>
        this.event(rel, name === null ? null : name.toString()),
      );
    } catch (err) {
      // Out of inotify watches: the vault cannot be followed reliably, so it falls back to disk reads.
      if (rel === "" || (err as NodeJS.ErrnoException).code === "ENOSPC") {
        if (rel === "") throw err;
        return this.onError(err);
      }
      return; // gone again already; its parent reported that
    }
    watcher.on("error", (err) => {
      if (rel === "") return this.onError(err);
      this.remove(rel);
    });
    this.watchers.set(rel, watcher);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith("."))
        this.add(rel ? `${rel}/${entry.name}` : entry.name);
    }
  }

  private remove(rel: string): void {
    for (const [key, watcher] of this.watchers) {
      if (key === rel || key.startsWith(`${rel}/`)) {
        watcher.close();
        this.watchers.delete(key);
      }
    }
  }

  private event(folder: string, name: string | null): void {
    if (this.closed) return;
    if (name === null) return this.onChange(null);
    if (name.startsWith(".")) return;
    const rel = folder ? `${folder}/${name}` : name;
    this.onChange(rel);
    // A folder that appeared needs watching; one that went away stops being watched.
    void lstat(path.join(this.root, ...rel.split("/"))).then(
      (info) => {
        if (info.isDirectory()) {
          this.add(rel);
          // Files may have been put in it before its watcher started.
          this.onChange(rel);
        }
      },
      () => this.remove(rel),
    );
  }
}

/** Every visible file below `dir` (as vault-relative paths), for the safety-net check. */
async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(path.join(dir, ...rel.split("/").filter(Boolean)), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** One memory budget shared by every vault's cache; least recently used files go first. */
class CacheStore {
  private bytes = 0;
  /** Insertion order = least recently used first. */
  private readonly order = new Map<string, VaultCache>();

  constructor(private readonly maxBytes: number) {}

  use(cache: VaultCache, key: string, bytes: number): void {
    this.bytes += bytes;
    const k = `${cache.dir}\0${key}`;
    this.order.delete(k);
    this.order.set(k, cache);
    for (const [k, owner] of this.order) {
      if (this.bytes <= this.maxBytes) break;
      owner.drop(k.slice(k.indexOf("\0") + 1));
    }
  }

  touch(cache: VaultCache, key: string): void {
    // Use order only matters near the budget; skipping it otherwise keeps a scan of every file cheap.
    if (this.bytes < this.maxBytes * 0.8) return;
    const k = `${cache.dir}\0${key}`;
    this.order.delete(k);
    this.order.set(k, cache);
  }

  forget(cache: VaultCache, key: string): void {
    this.order.delete(`${cache.dir}\0${key}`);
  }

  release(bytes: number): void {
    this.bytes -= bytes;
  }
}

/** Caches for every vault, created when a vault is first read and dropped when it goes away. */
export class VaultCaches {
  private readonly caches = new Map<string, VaultCache>();
  private readonly brokenUntil = new Map<string, number>();
  private readonly store: CacheStore;

  constructor(
    private readonly log: Logger,
    private readonly options: { enabled?: boolean; maxBytes?: number } = {},
  ) {
    this.store = new CacheStore(options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES);
  }

  /**
   * The cache for a vault folder, or undefined when nothing may be cached for it right now.
   * `onExternal` hears about changes made outside the app (vault-relative paths; "" = anything).
   */
  get(key: string, dir: string, onExternal: (paths: string[]) => void): VaultCache | undefined {
    if (this.options.enabled === false) return undefined;
    const existing = this.caches.get(key);
    if (existing) return existing;
    if ((this.brokenUntil.get(key) ?? 0) > Date.now()) return undefined;
    const cache: VaultCache = new VaultCache(
      dir,
      this.store,
      () => {
        this.drop(key);
        this.brokenUntil.set(key, Date.now() + WATCH_RETRY_MS);
        onExternal([""]); // reads come from the disk now, and anything may have changed meanwhile
      },
      this.log,
      onExternal,
    );
    if (!cache.start()) {
      this.brokenUntil.set(key, Date.now() + WATCH_RETRY_MS);
      return undefined;
    }
    this.caches.set(key, cache);
    return cache;
  }

  /** The cache if there already is one (for invalidation: no need to create one). */
  peek(key: string): VaultCache | undefined {
    return this.caches.get(key);
  }

  /** Stops watching and forgets a vault (removed, archived, or its watcher failed). */
  drop(key: string): void {
    const cache = this.caches.get(key);
    if (!cache) return;
    this.caches.delete(key);
    cache.close();
  }

  closeAll(): void {
    for (const key of [...this.caches.keys()]) this.drop(key);
  }
}

export type { VaultCache };
