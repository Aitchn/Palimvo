import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  applyContent,
  cleanName,
  collabKind,
  docContent,
  makeAuthor,
  normalizeVaultPath,
  type Author,
  type CollabKind,
  type FileContent,
} from "@palimvo/core";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { errorFields } from "../errors.ts";
import type { ChangeNote, ChangeRecorder } from "../history/history.ts";
import type { Logger } from "../log.ts";
import { contentVersion } from "../vault/fsutil.ts";
import { SharedExclusiveMutex } from "../vault/mutex.ts";
import type { BatchWrite, VaultService, WriteResult } from "../vault/service.ts";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export interface CollabOptions {
  logger: Logger;
  /** Persist this long after the last edit... */
  persistDelayMs?: number;
  /** ...but at least this often while edits keep coming. */
  persistMaxDelayMs?: number;
  /** Keep a document in memory this long after its last client leaves. */
  unloadDelayMs?: number;
  /** How often idle live documents look for edits made outside the app (Obsidian, git pull, a sync tool). */
  diskCheckMs?: number;
  pingMs?: number;
  /** Told who changed which file, for the version history. */
  recorder?: ChangeRecorder;
}

type HubOptions = Required<Omit<CollabOptions, "recorder">> & Pick<CollabOptions, "recorder">;

const DEFAULTS = {
  persistDelayMs: 1000,
  persistMaxDelayMs: 5000,
  unloadDelayMs: 30_000,
  diskCheckMs: 3000,
  pingMs: 30_000,
};

/** Origin tag for changes that came from the file on disk or the REST API rather than a client. */
const EXTERNAL = Symbol("external");

/** Close code telling a client its copy of the document comes from a different lineage (ADR 0011). */
export const STALE_LINEAGE = 4409;
/** Close code for a connection whose person lost access to the vault. */
export const UNAUTHORIZED = 4401;
/** Close code for a document that was deleted, moved away, or whose vault was removed. */
export const GONE = 4404;

/** Who is credited for a change when nothing says who made it. */
const ANONYMOUS = makeAuthor("human", "Anonymous", { id: "anonymous" });

export interface ConnectOptions {
  /** The signed-in person; their edits are attributed to this author. */
  author?: Author;
  /** Viewers see live changes but cannot edit. */
  readOnly?: boolean;
  /** Asks again whether this connection may stay open, and how; null closes it. */
  recheck?: () => Promise<ConnectOptions | null>;
}

export interface WriteOptions {
  baseVersion?: string | null | undefined;
  author?: Author | undefined;
  note?: ChangeNote | undefined;
}

/**
 * The Yjs state that matches a file version. Rebuilding a document from text gives it new
 * internal ids, and clients still holding the old document would then duplicate everything on
 * reconnect. Saving the state keeps the ids stable across restarts and unloads; `lineage` names
 * one such history.
 */
interface SavedState {
  version: string;
  lineage: string;
  update: string; // base64 of Y.encodeStateAsUpdate
}

/** Where a file's saved state lives in the vault's `.palimvo/` folder (never in git, see history.ts). */
function stateName(path: string): string {
  return `collab/${createHash("sha1").update(path).digest("hex")}.json`;
}

function lineageOf(doc: Y.Doc): string | undefined {
  const value = doc.getMap("collab.meta").get("lineage");
  return typeof value === "string" ? value : undefined;
}

/** Restores saved state if it still describes `file`, otherwise starts a new lineage from the text. */
function buildDoc(
  doc: Y.Doc,
  kind: CollabKind,
  file: FileContent,
  saved: SavedState | null,
): boolean {
  if (saved && saved.version === file.version) {
    const update = Buffer.from(saved.update, "base64");
    const probe = new Y.Doc();
    try {
      Y.applyUpdate(probe, update);
      if (lineageOf(probe) === saved.lineage && docContent(probe, kind) === file.content) {
        Y.applyUpdate(doc, update, EXTERNAL);
        return true;
      }
    } catch {
      // corrupt state; fall through to a fresh lineage
    } finally {
      probe.destroy();
    }
  }
  doc.transact(() => {
    doc.getMap("collab.meta").set("lineage", randomUUID());
    applyContent(doc, kind, file.content, EXTERNAL);
  }, EXTERNAL);
  return false;
}

function isVersionConflict(err: unknown): err is AppError {
  return err instanceof AppError && err.code === "version_conflict";
}

/** The file as the other side wrote it, from a `version_conflict` error. */
function currentOf(err: AppError): FileContent | null {
  const current = (err.details as { current?: FileContent | null } | undefined)?.current;
  return current ?? null;
}

/**
 * A file being edited live. The Y.Doc is the source of truth while it exists; the file on disk
 * follows it within `persistMaxDelayMs`.
 */
class LiveDoc {
  private batchHeld = false;
  private batchMessages: { ws: WebSocket; data: Uint8Array }[] = [];
  private batchMessageBytes = 0;
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Map<WebSocket, Set<number>>();
  /** Who is behind each connection (when signed in) and whether they may only watch. */
  private readonly connInfo = new Map<WebSocket, ConnectOptions>();
  /** Content and version of the file as we last wrote or read it. */
  persisted: FileContent;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private firstDirtyAt: number | undefined;
  private persisting: Promise<void> = Promise.resolve();
  unloadTimer: ReturnType<typeof setTimeout> | undefined;
  private diskTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private frozen = false;
  private diskCandidate: string | undefined;
  private stateWrites: Promise<void> = Promise.resolve();
  /** Whether the saved state on disk matches `persisted`. */
  private stateSaved: boolean;
  readonly lineage: string;
  /** Who changed the document since it was last written to disk, most recent last, with their stated reasons. */
  private editors = new Map<string, { author: Author; reasons: string[] }>();

  constructor(
    readonly vault: string,
    readonly path: string,
    readonly kind: CollabKind,
    file: FileContent,
    saved: SavedState | null,
    private readonly vaults: VaultService,
    private readonly opts: HubOptions,
  ) {
    this.persisted = file;
    this.stateSaved = buildDoc(this.doc, kind, file, saved);
    this.lineage = lineageOf(this.doc)!;
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_SYNC);
      syncProtocol.writeUpdate(message, update);
      this.broadcast(encoding.toUint8Array(message));
      if (origin !== EXTERNAL) {
        this.noteEditor(this.editorOf(origin));
        this.schedulePersist();
      }
    });

    this.awareness.on(
      "update",
      (
        changes: { added: number[]; updated: number[]; removed: number[] },
        conn: WebSocket | null,
      ) => {
        const changed = [...changes.added, ...changes.updated, ...changes.removed];
        if (conn) {
          const ids = this.conns.get(conn);
          if (ids) {
            for (const id of changes.added) ids.add(id);
            for (const id of changes.removed) ids.delete(id);
          }
        }
        const message = encoding.createEncoder();
        encoding.writeVarUint(message, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          message,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        this.broadcast(encoding.toUint8Array(message));
      },
    );

    this.diskTimer = setInterval(() => void this.checkDisk(), opts.diskCheckMs);
    this.diskTimer.unref();
  }

  /** The person behind a connection, from the name their editor shares for cursors. */
  private editorOf(origin: unknown): Author {
    const known = this.connInfo.get(origin as WebSocket)?.author;
    if (known) return known; // a signed-in account, not the self-chosen cursor name
    const ids = this.conns.get(origin as WebSocket);
    for (const id of ids ?? []) {
      const user = this.awareness.getStates().get(id)?.user as { name?: unknown } | undefined;
      const name = typeof user?.name === "string" ? cleanName(user.name) : "";
      if (name) return makeAuthor("human", name);
    }
    return ANONYMOUS;
  }

  noteEditor(author: Author, reason?: string): void {
    const k = `${author.kind}:${author.id}`;
    const entry = this.editors.get(k) ?? { author, reasons: [] };
    if (reason) entry.reasons.push(reason);
    this.editors.delete(k);
    this.editors.set(k, entry);
  }

  get content(): string {
    return docContent(this.doc, this.kind);
  }

  get dirty(): boolean {
    return this.content !== this.persisted.content;
  }

  /** Current state as a file, from memory (fresher than disk). */
  snapshot(): FileContent {
    const content = this.content;
    return { path: this.path, content, mtime: Date.now(), version: contentVersion(content) };
  }

  /** `early` holds messages the client sent while its document was still loading. */
  addConnection(ws: WebSocket, early: Uint8Array[] = [], options: ConnectOptions = {}): void {
    clearTimeout(this.unloadTimer);
    this.conns.set(ws, new Set());
    this.connInfo.set(ws, options);

    ws.on("message", (data: Buffer) => this.handleMessage(ws, new Uint8Array(data)));

    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.opts.pingMs);
    ping.unref();
    ws.on("close", () => {
      clearInterval(ping);
      const ids = this.conns.get(ws);
      this.conns.delete(ws);
      this.connInfo.delete(ws);
      if (ids?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
    });

    // Start the sync handshake and share who else is here.
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, this.doc);
    ws.send(encoding.toUint8Array(step1));
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        message,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      ws.send(encoding.toUint8Array(message));
    }
    for (const data of early) this.handleMessage(ws, data);
  }

  /** Malformed input must not abort a committed batch or discard another peer's queued edits. */
  private handleMessage(ws: WebSocket, data: Uint8Array): void {
    try {
      this.onMessage(ws, data);
    } catch (err) {
      this.opts.logger.warn("bad collab message", { path: this.path, ...errorFields(err) });
      try {
        ws.close(1003, "bad message");
      } catch {
        ws.terminate();
      }
    }
  }

  private onMessage(ws: WebSocket, data: Uint8Array): void {
    if (this.closed || this.frozen) return;
    if (this.batchHeld) {
      // Bounded buffering: a noisy peer reconnects rather than consuming unbounded RAM.
      if (
        this.batchMessages.length >= 1000 ||
        this.batchMessageBytes + data.byteLength > 10 * 1024 * 1024
      ) {
        ws.close(1013, "transaction busy");
        return;
      }
      this.batchMessages.push({ ws, data: data.slice() });
      this.batchMessageBytes += data.byteLength;
      return;
    }
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      // Viewers may ask for the document (step 1) but their changes are dropped.
      if (
        this.connInfo.get(ws)?.readOnly &&
        decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1
      ) {
        return;
      }
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, reply, this.doc, ws);
      if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        ws,
      );
    }
  }

  private broadcast(message: Uint8Array): void {
    for (const ws of this.conns.keys()) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(message);
        } catch {
          ws.terminate();
        }
      }
    }
  }

  private schedulePersist(): void {
    if (this.batchHeld || this.closed) return;
    this.firstDirtyAt ??= Date.now();
    clearTimeout(this.persistTimer);
    const wait = Math.min(
      this.opts.persistDelayMs,
      this.firstDirtyAt + this.opts.persistMaxDelayMs - Date.now(),
    );
    this.persistTimer = setTimeout(
      () => void this.persist().catch(() => undefined),
      Math.max(0, wait),
    );
  }

  /**
   * Writes the document to disk if it changed. Persists run one after another. Rejects when the
   * write failed, so a caller that needs the text on disk (a move, a checkpoint, shutdown) can
   * tell; the failure is also retried in the background while the document lives.
   */
  persist(): Promise<void> {
    clearTimeout(this.persistTimer);
    this.firstDirtyAt = undefined;
    const run = this.persisting.then(() => this.persistNow());
    this.persisting = run.catch((err) => {
      this.opts.logger.error("persist failed", {
        vault: this.vault,
        path: this.path,
        ...errorFields(err),
      });
      this.schedulePersist(); // retry later; the edits are still in memory
    });
    return run;
  }

  /** Shutdown: from now on messages from clients are ignored and every socket is closed. */
  freeze(): void {
    this.frozen = true;
    clearTimeout(this.unloadTimer);
    for (const ws of this.conns.keys()) ws.close(1001, "server shutting down");
  }

  /** Resolves when no persist or state write is running. */
  async settled(): Promise<void> {
    await this.persisting;
    await this.stateWrites;
  }

  private async persistNow(): Promise<void> {
    if (this.closed) return;
    const content = this.content;
    if (content === this.persisted.content) {
      if (!this.stateSaved) await this.saveState();
      return;
    }
    // Captured together with `content`, so the saved state matches the written file.
    const update = Y.encodeStateAsUpdate(this.doc);
    const editors = this.editors;
    this.editors = new Map();
    // Recorded before the write queue is released, so a history commit never sees the file unattributed.
    const onWritten = () => {
      for (const { author, reasons } of editors.values()) {
        const reason = reasons.join("; ");
        this.opts.recorder?.record(
          this.vault,
          [this.path],
          author,
          reason ? { reason } : undefined,
        );
      }
    };
    try {
      await this.write(content, onWritten);
    } catch (err) {
      // Keep the attribution for the retry.
      for (const [k, entry] of this.editors) editors.set(k, entry);
      this.editors = editors;
      throw err;
    }
    await this.saveState(update);
  }

  private async write(content: string, onWritten: () => void): Promise<void> {
    try {
      this.persisted = await this.vaults.writeFile(this.vault, this.path, content, {
        baseVersion: this.persisted.version,
        onWritten,
      });
    } catch (err) {
      if (!isVersionConflict(err)) throw err;
      // Someone changed the file on disk outside the app while we had unsaved edits.
      // Keep both: ours becomes the file, theirs is saved next to it.
      const current = currentOf(err);
      if (current) {
        const copy = conflictCopyPath(this.path);
        await this.vaults.writeFile(this.vault, copy, current.content, { baseVersion: null });
        this.opts.logger.warn("external edit conflicted with live edits; saved a conflict copy", {
          path: this.path,
          copy,
        });
      }
      this.persisted = await this.vaults.writeFile(this.vault, this.path, content, {
        baseVersion: current?.version ?? null,
        onWritten,
      });
    }
  }

  /** Records the Yjs state for the current file version; failures only cost lineage continuity. */
  saveState(update = Y.encodeStateAsUpdate(this.doc)): Promise<void> {
    const state: SavedState = {
      version: this.persisted.version,
      lineage: this.lineage,
      update: Buffer.from(update).toString("base64"),
    };
    this.stateSaved = true;
    this.stateWrites = this.stateWrites
      .then(() => this.vaults.writeMeta(this.vault, stateName(this.path), JSON.stringify(state)))
      .catch((err) => {
        this.stateSaved = false;
        this.opts.logger.warn("saving collab state failed", {
          vault: this.vault,
          path: this.path,
          ...errorFields(err),
        });
      });
    return this.stateWrites;
  }

  /** Pull in edits made directly on disk while nobody here has unsaved changes. */
  private async checkDisk(): Promise<void> {
    if (this.closed || this.dirty || this.batchHeld) return;
    let file: FileContent;
    try {
      file = await this.vaults.readFile(this.vault, this.path, { fresh: true });
    } catch {
      return; // deleted or unreadable; handled by delete/move hooks or the next persist
    }
    if (this.closed || file.version === this.persisted.version || this.dirty) {
      this.diskCandidate = undefined;
      return;
    }
    // Other programs may write in several steps (truncate, then write). Only adopt a
    // version once it has stayed the same for a whole check interval.
    if (this.diskCandidate !== file.version) {
      this.diskCandidate = file.version;
      return;
    }
    this.diskCandidate = undefined;
    try {
      applyContent(this.doc, this.kind, file.content, EXTERNAL);
      this.persisted = file;
      void this.saveState();
    } catch (err) {
      this.opts.logger.warn("ignoring unparsable external edit", {
        path: this.path,
        ...errorFields(err),
      });
    }
  }

  /** Applies a write that arrived through the REST API (e.g. from an AI) as a merge into the live document. */
  async applyExternal(
    content: string,
    baseVersion: string | null | undefined,
    author: Author,
    reason?: string,
  ): Promise<FileContent> {
    const current = this.snapshot();
    if (baseVersion !== undefined && baseVersion !== current.version) {
      throw new AppError("version_conflict", undefined, { path: this.path, current });
    }
    applyContent(this.doc, this.kind, content, EXTERNAL);
    this.noteEditor(author, reason);
    await this.persist();
    return this.snapshot();
  }

  /** Hold socket updates while the disk transaction is validated and committed. */
  holdBatch(): void {
    this.batchHeld = true;
    clearTimeout(this.persistTimer);
    clearTimeout(this.unloadTimer);
  }

  get heldForBatch(): boolean {
    return this.batchHeld;
  }

  releaseBatch(): void {
    this.batchHeld = false;
    const messages = this.batchMessages;
    this.batchMessages = [];
    this.batchMessageBytes = 0;
    if (this.closed) return;
    for (const { ws, data } of messages) {
      if (this.conns.has(ws) && ws.readyState === ws.OPEN) this.handleMessage(ws, data);
    }
    if (this.dirty) this.schedulePersist();
  }

  /** The batch wrote `file` to disk: the live document follows. */
  commitBatch(file: FileContent): void {
    applyContent(this.doc, this.kind, file.content, EXTERNAL);
    this.persisted = file;
    this.diskCandidate = undefined;
    this.stateSaved = false;
    void this.saveState();
  }

  /** Asks each connection's `recheck` again; closes the ones that lost access and updates the rest. */
  async reauthorize(): Promise<void> {
    await Promise.all(
      [...this.connInfo].map(async ([ws, info]) => {
        if (!info.recheck) return;
        let next: ConnectOptions | null;
        try {
          next = await info.recheck();
        } catch {
          return; // keep the connection; the next check tries again
        }
        if (!this.connInfo.has(ws)) return;
        if (!next) ws.close(UNAUTHORIZED, "access revoked");
        else this.connInfo.set(ws, { ...next, recheck: info.recheck });
      }),
    );
  }

  close(code: number, reason: string): void {
    this.closed = true;
    clearTimeout(this.persistTimer);
    clearTimeout(this.unloadTimer);
    clearInterval(this.diskTimer);
    for (const ws of this.conns.keys()) ws.close(code, reason);
    this.conns.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

function conflictCopyPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path.slice(0, dot)} (conflict ${stamp})${path.slice(dot)}`;
}

/** One lock per file, whatever spelling of its path a caller used. */
function fileKey(path: string): string {
  try {
    const normalized = normalizeVaultPath(path);
    return process.platform === "win32" || process.platform === "darwin"
      ? normalized.toLowerCase()
      : normalized;
  } catch {
    return path; // the read or write itself reports the bad path
  }
}

function key(vault: string, path: string): string {
  return `${vault}\u0000${fileKey(path)}`;
}

/**
 * Owns the live documents of all vaults and routes reads, writes and WebSocket clients to them.
 * A file with a live document is read from it and written through it, so a REST write from an AI
 * merges into what people are typing instead of replacing it.
 */
export class CollabHub {
  /**
   * Opening a document and writing one file run alongside work on other files of the vault
   * (one at a time per file); batches, moves, deletes and closing a vault run alone.
   */
  private readonly operations = new SharedExclusiveMutex();
  private readonly docs = new Map<string, LiveDoc>();
  private readonly loading = new Map<string, Promise<LiveDoc>>();
  private readonly opts: HubOptions;
  private readonly log: Logger;

  constructor(
    private readonly vaults: VaultService,
    options: CollabOptions,
  ) {
    this.opts = { ...DEFAULTS, ...options };
    this.log = options.logger;
  }

  /**
   * Accepts a client for a file; rejects files that do not exist or are not markdown/canvas.
   * `lineage` is the lineage the client's copy belongs to, if it has one; a mismatch closes the
   * connection with STALE_LINEAGE instead of merging.
   */
  async connect(
    ws: WebSocket,
    vault: string,
    path: string,
    lineage?: string,
    options: ConnectOptions = {},
  ): Promise<void> {
    // Clients start talking immediately; keep what arrives while the document loads.
    const early: Uint8Array[] = [];
    const buffer = (data: Buffer) => early.push(new Uint8Array(data));
    ws.on("message", buffer);
    let live: LiveDoc;
    try {
      live = await this.operations.shared(vault, fileKey(path), () => this.open(vault, path));
    } finally {
      ws.off("message", buffer);
    }
    if (ws.readyState !== ws.OPEN || (lineage && lineage !== live.lineage)) {
      if (ws.readyState === ws.OPEN) ws.close(STALE_LINEAGE, "stale document");
      if (live.conns.size === 0) this.scheduleUnload(live);
      return;
    }
    live.addConnection(ws, early, options);
    ws.on("close", () => {
      if (live.conns.size === 0) this.scheduleUnload(live);
    });
  }

  /** Reads through the live document when there is one. */
  async readFile(vault: string, path: string): Promise<FileContent> {
    const live = this.find(vault, path);
    if (live) return live.snapshot();
    return this.vaults.readFile(vault, path);
  }

  /** Writes merge into the live document when there is one, so they never clobber concurrent edits. */
  writeFile(
    vault: string,
    path: string,
    content: string,
    options: WriteOptions = {},
  ): Promise<FileContent> {
    return this.operations.shared(vault, fileKey(path), async () => {
      const live = this.find(vault, path);
      const author = options.author ?? ANONYMOUS;
      if (live) {
        return live.applyExternal(content, options.baseVersion, author, options.note?.reason);
      }
      return this.vaults.writeFile(vault, path, content, {
        baseVersion: options.baseVersion,
        onWritten: (file) => this.opts.recorder?.record(vault, [file.path], author, options.note),
      });
    });
  }

  /**
   * Writes several files as one unit. Live documents among them are flushed first and hold their
   * socket input until the batch is on disk; afterwards they show what was written.
   */
  applyBatch(
    vault: string,
    changes: readonly BatchWrite[],
    options: WriteOptions = {},
  ): Promise<WriteResult[]> {
    return this.operations.exclusive(vault, async () => {
      const wanted = new Map<string, string>();
      for (const change of changes) {
        if ("content" in change) wanted.set(key(vault, change.path), change.content);
      }
      const liveDocs = changes
        .map((c) => this.find(vault, c.path))
        .filter((d): d is LiveDoc => d !== undefined);
      for (const live of liveDocs) live.holdBatch();
      try {
        await Promise.all(
          liveDocs.map(async (live) => {
            await live.persist();
            await live.settled();
            if (live.dirty) {
              throw new AppError("internal", undefined, { path: live.path });
            }
          }),
        );
        for (const change of changes) {
          const live = this.find(vault, change.path);
          if (!live) continue;
          const snapshot = live.snapshot();
          if (change.baseVersion !== snapshot.version) {
            throw new AppError("version_conflict", undefined, {
              path: change.path,
              current: snapshot,
            });
          }
          // A canvas that does not parse must fail before anything is written.
          const text = wanted.get(key(vault, change.path));
          if (text !== undefined) {
            const probe = new Y.Doc();
            try {
              applyContent(probe, live.kind, text, EXTERNAL);
            } finally {
              probe.destroy();
            }
          }
        }
        const author = options.author ?? ANONYMOUS;
        return await this.vaults.writeBatch(vault, changes, {
          onWritten: (results) => {
            // Published under the vault's write lock, before change listeners or history can observe it.
            for (const result of results) {
              const content = wanted.get(key(vault, result.path));
              if (content === undefined) continue;
              this.find(vault, result.path)?.commitBatch({
                path: result.path,
                content,
                mtime: result.mtime,
                version: result.version,
              });
            }
            this.opts.recorder?.record(
              vault,
              results.map((r) => r.path),
              author,
              options.note,
            );
          },
        });
      } finally {
        for (const live of liveDocs) {
          live.releaseBatch();
          if (!live.conns.size) this.scheduleUnload(live);
        }
      }
    });
  }

  /**
   * Runs `change` (a delete or a move of a file or folder on disk) after closing the live
   * documents inside it, telling connected editors that it is gone. Unsaved edits are written
   * first when the file is only being moved.
   */
  mutate<T>(
    vault: string,
    path: string,
    reason: "deleted" | "moved",
    change: () => Promise<T>,
  ): Promise<T> {
    return this.operations.exclusive(vault, async () => {
      let prefix: string;
      try {
        prefix = fileKey(normalizeVaultPath(path));
      } catch {
        return change(); // the change itself reports the bad path
      }
      // `path` may be a folder: every document inside it goes too.
      const inside = [...this.docs.values()].filter(
        (d) =>
          d.vault === vault &&
          (fileKey(d.path) === prefix || fileKey(d.path).startsWith(`${prefix}/`)),
      );
      await Promise.all(
        inside.map(async (live) => {
          // A failed save stops the move: closing now would throw the unsaved text away.
          if (reason === "moved") await live.persist();
          this.docs.delete(key(vault, live.path));
          live.close(GONE, reason);
          await live.settled();
          await this.vaults.deleteMeta(vault, stateName(live.path)).catch(() => undefined);
        }),
      );
      return change();
    });
  }

  /**
   * The vault is being removed: closes all its live documents (telling editors it is gone) and
   * waits until none of them writes again. Call `flushVault` first to keep unsaved edits.
   */
  closeVault(vault: string): Promise<void> {
    return this.operations.exclusive(vault, async () => {
      const inside = [...this.docs.values()].filter((d) => d.vault === vault);
      await Promise.all(
        inside.map(async (live) => {
          this.docs.delete(key(vault, live.path));
          live.close(GONE, "vault removed");
          await live.settled();
        }),
      );
    });
  }

  /** Persists the live documents of one vault, e.g. before a checkpoint commit. */
  async flushVault(vault: string): Promise<void> {
    await Promise.all(
      [...this.docs.values()].filter((d) => d.vault === vault).map((d) => d.persist()),
    );
  }

  /** Persists every live document; used on shutdown. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.docs.values()].map((d) => d.persist()));
    await Promise.all([...this.docs.values()].map((d) => d.settled()));
  }

  /**
   * Shutdown: stops taking edits from clients (they keep theirs and merge after the restart),
   * writes every document, then closes them. Rejects if a write failed; documents are closed
   * either way.
   */
  async shutdown(): Promise<void> {
    for (const live of this.docs.values()) live.freeze();
    try {
      await this.flushAll();
    } finally {
      await this.closeAll();
    }
  }

  /** Re-checks who may still use each open connection, e.g. after a role change or sign-out. */
  async reauthorize(): Promise<void> {
    await Promise.all([...this.docs.values()].map((d) => d.reauthorize()));
  }

  /** Disconnects every client and drops all documents. Call after `flushAll`. */
  async closeAll(): Promise<void> {
    await this.operations.idle();
    for (const live of this.docs.values()) live.close(1001, "server shutting down");
    this.docs.clear();
  }

  /** Live documents in memory. */
  get size(): number {
    return this.docs.size;
  }

  /** Live editing connections across all documents. */
  get connections(): number {
    let n = 0;
    for (const live of this.docs.values()) n += live.conns.size;
    return n;
  }

  private find(vault: string, path: string): LiveDoc | undefined {
    return this.docs.get(key(vault, path));
  }

  private async open(vault: string, path: string): Promise<LiveDoc> {
    const kind = collabKind(path);
    if (!kind) throw new AppError("not_found", undefined, { path });
    // A live document must start from disk, not from a cache that may trail it.
    const file = await this.vaults.readFile(vault, path, { fresh: true });
    const k = key(vault, file.path);
    const existing = this.docs.get(k);
    if (existing) return existing;
    let pending = this.loading.get(k);
    if (!pending) {
      pending = this.loadState(vault, file.path).then((saved) => {
        const live = new LiveDoc(vault, file.path, kind, file, saved, this.vaults, this.opts);
        this.docs.set(k, live);
        void live.persist().catch(() => undefined); // saves the state if it was new
        return live;
      });
      this.loading.set(k, pending);
      const forget = () => this.loading.delete(k);
      pending.then(forget, forget); // a document that fails to open must not also crash the process
    }
    return pending;
  }

  private async loadState(vault: string, path: string): Promise<SavedState | null> {
    try {
      const raw = await this.vaults.readMeta(vault, stateName(path));
      return raw ? (JSON.parse(raw) as SavedState) : null;
    } catch (err) {
      this.log.warn("ignoring unreadable collab state", { vault, path, ...errorFields(err) });
      return null;
    }
  }

  private scheduleUnload(live: LiveDoc): void {
    clearTimeout(live.unloadTimer);
    live.unloadTimer = setTimeout(async () => {
      if (live.conns.size > 0 || live.heldForBatch) return;
      try {
        await live.persist();
      } catch {
        return; // stays in memory; its own retry keeps trying
      }
      if (live.conns.size > 0 || this.docs.get(key(live.vault, live.path)) !== live) return;
      this.docs.delete(key(live.vault, live.path));
      live.close(1000, "idle");
    }, this.opts.unloadDelayMs);
    live.unloadTimer.unref();
  }
}
