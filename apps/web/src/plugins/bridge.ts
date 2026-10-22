import { InvalidPathError, normalizeVaultPath, type TreeNode } from "@palimvo/core";
import type { BaseQueryResult, VaultListEntry, VaultSearchHit } from "@palimvo/plugin-sdk";
import {
  MAX_BINARY_BYTES,
  MAX_PENDING_REQUESTS,
  MAX_REQUEST_IDS,
  RPC_TIMEOUT_MS,
  RpcError,
  parseRpc,
  plainData,
  type RpcRequest,
} from "./protocol.ts";
import { canRead, canWrite, type PluginSession } from "./session.ts";

/** What the host reaches the vault with: the app's own API, so the person's rights apply on the server too. */
export interface VaultBackend {
  read(path: string, signal: AbortSignal): Promise<string>;
  readBinary(path: string, signal: AbortSignal): Promise<Uint8Array>;
  tree(signal: AbortSignal): Promise<readonly TreeNode[]>;
  search(
    query: string,
    options: { limit: number; folder?: string },
    signal: AbortSignal,
  ): Promise<VaultSearchHit[]>;
  queryBase(path: string, view: string | undefined, signal: AbortSignal): Promise<BaseQueryResult>;
  write(
    path: string,
    content: string,
    reason: string | undefined,
    signal: AbortSignal,
  ): Promise<{ revision: string }>;
  propose(
    input: { path: string; content: string; title?: string; reason?: string },
    signal: AbortSignal,
  ): Promise<{ proposalId: string }>;
}

/** What a plugin can ask the app to do on screen. */
export interface HostActions {
  openFile(path: string): void;
  showNotice(message: string, kind: "info" | "success" | "error"): void;
  /** Replaces the source of the code block this frame draws; absent for other frames. */
  updateSource?(source: string): Promise<void>;
  /** Asks the enabled contributors of one of this plugin's own extension points. */
  invokeExtension(point: string, input: unknown, signal: AbortSignal): Promise<unknown[]>;
}

const DEFAULT_SEARCH_LIMIT = 20;

function pathOf(raw: unknown): string {
  try {
    return normalizeVaultPath(raw as string);
  } catch (error) {
    if (error instanceof InvalidPathError) throw new RpcError("invalid_argument", error.message);
    throw error;
  }
}

function denied(what: string, path: string): RpcError {
  return new RpcError("permission_denied", `The plugin may not ${what} "${path}"`);
}

/** Folders and files under `dir` that the plugin may see; a folder shows only if it leads to a readable file. */
export function visibleEntries(
  tree: readonly TreeNode[],
  dir: string,
  recursive: boolean,
  readable: (path: string) => boolean,
): VaultListEntry[] {
  const out: VaultListEntry[] = [];
  const hasReadable = (node: TreeNode): boolean =>
    node.type === "file" ? readable(node.path) : (node.children ?? []).some(hasReadable);
  const visit = (nodes: readonly TreeNode[], descend: boolean) => {
    for (const node of nodes) {
      if (node.type === "file") {
        if (readable(node.path)) out.push({ path: node.path, name: node.name, kind: "file" });
      } else if (hasReadable(node)) {
        out.push({ path: node.path, name: node.name, kind: "folder" });
        if (descend) visit(node.children ?? [], true);
      }
    }
  };
  let level: readonly TreeNode[] = tree;
  if (dir !== "") {
    let found: TreeNode | undefined;
    for (const part of dir.split("/")) {
      found = level.find((node) => node.type === "folder" && node.name === part);
      if (!found) return [];
      level = found.children ?? [];
    }
  }
  visit(level, recursive);
  return out;
}

interface Pending {
  controller: AbortController;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One frame's calls into the app. Every call is checked against the plugin's declared folders
 * and the person's rights, may be cancelled, times out, and stops when the session is revoked.
 */
export class PluginBridge {
  private pending = new Map<string, Pending>();
  private seen = new Set<string>();
  private disposed = false;
  private unsubscribe: () => void;

  constructor(
    readonly session: PluginSession,
    private backend: VaultBackend,
    private actions: HostActions,
    private timeoutMs = RPC_TIMEOUT_MS,
  ) {
    this.unsubscribe = session.onRevoke((reason) => this.dispose(reason));
  }

  request(value: unknown): Promise<unknown> {
    let request: RpcRequest;
    try {
      if (this.disposed) throw new Error("The plugin was stopped");
      this.session.assert();
      request = parseRpc(value);
      if (this.seen.has(request.requestId)) throw new Error("Request id already used");
      // A frame cannot cycle old ids, and cannot queue unbounded work.
      if (this.seen.size >= MAX_REQUEST_IDS)
        throw new Error("Request limit reached; reopen the view");
      if (this.pending.size >= MAX_PENDING_REQUESTS) throw new Error("Too many calls in flight");
      this.seen.add(request.requestId);
    } catch (error) {
      return Promise.reject(
        new RpcError("invalid_argument", error instanceof Error ? error.message : String(error)),
      );
    }
    const { requestId } = request;
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => this.cancel(requestId, new RpcError("unavailable", "The call timed out")),
        this.timeoutMs,
      );
      this.pending.set(requestId, { controller, reject, timer });
      Promise.resolve()
        .then(() => {
          this.session.assert();
          return this.dispatch(request, controller.signal);
        })
        .then((result) => {
          // A transport that ignores the abort signal still cannot deliver after cancel or revoke.
          if (!this.pending.has(requestId)) return;
          this.session.assert();
          this.finish(requestId);
          resolve(result);
        })
        .catch((error: unknown) => {
          if (!this.pending.has(requestId)) return;
          this.finish(requestId);
          reject(error);
        });
    });
  }

  private async dispatch(request: RpcRequest, signal: AbortSignal): Promise<unknown> {
    const { binding } = this.session;
    const p = request.params;
    switch (request.method) {
      case "vault.read": {
        const path = pathOf(p.path);
        if (!canRead(binding, path)) throw denied("read", path);
        return this.backend.read(path, signal);
      }
      case "vault.readBinary": {
        const path = pathOf(p.path);
        if (!canRead(binding, path)) throw denied("read", path);
        const bytes = await this.backend.readBinary(path, signal);
        if (bytes.byteLength > MAX_BINARY_BYTES)
          throw new RpcError("quota_exceeded", "The file is too large to read as bytes");
        return bytes;
      }
      case "vault.list": {
        const dir = p.dir ? pathOf(p.dir) : "";
        if (!binding.actor.read || binding.read.length === 0)
          throw new RpcError("permission_denied", "The plugin may not read this vault");
        const tree = await this.backend.tree(signal);
        return visibleEntries(tree, dir, p.recursive === true, (path) => canRead(binding, path));
      }
      case "vault.search": {
        if (!binding.actor.read || binding.read.length === 0)
          throw new RpcError("permission_denied", "The plugin may not read this vault");
        const folder = p.folder ? pathOf(p.folder) : undefined;
        const limit = typeof p.limit === "number" ? p.limit : DEFAULT_SEARCH_LIMIT;
        // Ask for more than needed: hits outside the plugin's folders are dropped afterwards.
        const hits = await this.backend.search(
          p.query as string,
          { limit: 100, ...(folder ? { folder } : {}) },
          signal,
        );
        return hits.filter((hit) => canRead(binding, hit.path)).slice(0, limit);
      }
      case "vault.queryBase": {
        const path = pathOf(p.path);
        if (!canRead(binding, path)) throw denied("read", path);
        const result = await this.backend.queryBase(
          path,
          typeof p.view === "string" ? p.view : undefined,
          signal,
        );
        // Rows are other notes: show the plugin only the ones in its folders.
        const rows = result.rows.filter((row) => {
          const rowPath = row.path ?? (row.file as { path?: unknown } | undefined)?.path;
          return typeof rowPath !== "string" || canRead(binding, rowPath);
        });
        return { columns: result.columns, rows };
      }
      case "vault.write": {
        const path = pathOf(p.path);
        if (!canWrite(binding, path)) throw denied("write", path);
        return this.backend.write(
          path,
          p.content as string,
          typeof p.reason === "string" ? p.reason : undefined,
          signal,
        );
      }
      case "vault.propose": {
        const path = pathOf(p.path);
        if (!canWrite(binding, path, true)) throw denied("propose a change to", path);
        return this.backend.propose(
          {
            path,
            content: p.content as string,
            ...(typeof p.title === "string" ? { title: p.title } : {}),
            ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
          },
          signal,
        );
      }
      case "ui.openFile": {
        const path = pathOf(p.path);
        // Opening only shows what the person can open anyway, but a plugin may not probe outside its folders.
        if (!canRead(binding, path)) throw denied("open", path);
        this.actions.openFile(path);
        return null;
      }
      case "ui.showNotice": {
        const kind = p.kind === "success" || p.kind === "error" ? p.kind : "info";
        this.actions.showNotice((p.message as string).slice(0, 300), kind);
        return null;
      }
      case "ui.updateSource": {
        if (!this.actions.updateSource)
          throw new RpcError("unavailable", "This view has no source to update");
        await this.actions.updateSource(p.source as string);
        return null;
      }
      case "extensions.invoke": {
        const point = p.point as string;
        if (!binding.extensionPoints.includes(point))
          throw new RpcError("permission_denied", `Undeclared extension point: ${point}`);
        const input = plainData(p.input ?? null, "Extension input");
        return this.actions.invokeExtension(point, input, signal);
      }
    }
  }

  private finish(id: string): void {
    const entry = this.pending.get(id);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(id);
  }

  /** Stops delivery and aborts what can be aborted; a write that already happened stays. */
  cancel(requestId: string, reason: Error = new RpcError("unavailable", "The call was cancelled")) {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.finish(requestId);
    entry.controller.abort(reason);
    entry.reject(reason);
  }

  dispose(reason = "The plugin was stopped"): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.pending.keys()]) this.cancel(id, new RpcError("unavailable", reason));
    this.unsubscribe();
  }
}
