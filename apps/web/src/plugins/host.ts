import type { FileChangedEvent } from "@palimvo/plugin-sdk";
import { satisfiesVersion } from "@palimvo/plugin-sdk";
import { apiBackend } from "./backend.ts";
import type { HostActions, VaultBackend } from "./bridge.ts";
import {
  mountPlugin,
  localeEvent,
  frameTokens,
  type LoadedPlugin,
  type MountedFrame,
  type MountOptions,
} from "./frame.ts";
import { EXTENSION_TIMEOUT_MS, plainData, type FrameMode } from "./protocol.ts";
import { PluginSession, bindingFor, canRead, type PluginActor } from "./session.ts";

export interface HostedPlugin {
  plugin: LoadedPlugin;
  session: PluginSession;
}

export interface HostOptions {
  vault: string;
  actor: PluginActor;
  locale: () => string;
  theme: () => "light" | "dark";
  openFile: (path: string) => void;
  showNotice: (message: string, kind: "info" | "success" | "error") => void;
  /** Where plugin calls go; the app's own API unless a test supplies another. */
  backend?: (pluginId: string) => VaultBackend;
}

export interface MountRequest {
  pluginId: string;
  mode: FrameMode;
  target: string;
  context?: Record<string, unknown>;
  /** Code block frames: the note that holds the block; `updateSource` is checked against it. */
  notePath?: string;
  /** Code block frames: replaces the block's source in the note. */
  updateSource?: (source: string) => Promise<void>;
  onReady?: MountOptions["onReady"];
  onResize?: MountOptions["onResize"];
  onError?: MountOptions["onError"];
  onStopped?: MountOptions["onStopped"];
}

/** The part of a file event one plugin may see, or null: moves across its folder border become create or delete. */
export function scopeFileEvent(
  binding: Parameters<typeof canRead>[0],
  event: FileChangedEvent,
): FileChangedEvent | null {
  const here = canRead(binding, event.path);
  if (event.kind === "moved" && event.from !== undefined) {
    const before = canRead(binding, event.from);
    if (here && before) return event;
    if (here) return { path: event.path, kind: "created", author: event.author };
    if (before) return { path: event.from, kind: "deleted", author: event.author };
    return null;
  }
  return here ? event : null;
}

export interface ExtensionAnswer {
  plugin: string;
  result?: unknown;
  error?: string;
}

/**
 * Everything that runs plugins in one open vault for one signed-in person: the approved set,
 * their revocable sessions, live frames, hidden frames that answer extension points, and
 * events. It does not touch React; `subscribe` lets a component re-read it.
 */
export class PluginHost {
  private hosted = new Map<string, HostedPlugin>();
  private live = new Set<{ pluginId: string; frame: MountedFrame }>();
  private background = new Map<string, MountedFrame>();
  private holder: HTMLElement | undefined;
  private listeners = new Set<() => void>();
  private disposed = false;
  private version = 0;
  private actor: PluginActor;

  constructor(private options: HostOptions) {
    this.actor = options.actor;
  }

  get vault(): string {
    return this.options.vault;
  }

  /** Increases whenever the approved set or a session changed. */
  get revision(): number {
    return this.version;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  list(): HostedPlugin[] {
    return [...this.hosted.values()].sort((a, b) =>
      a.plugin.manifest.id.localeCompare(b.plugin.manifest.id),
    );
  }

  get(id: string): HostedPlugin | undefined {
    return this.hosted.get(id);
  }

  /**
   * Makes `plugins` the approved set. A plugin whose hash is unchanged keeps its running frames;
   * one that changed or disappeared is revoked, which stops its frames at once.
   */
  setPlugins(plugins: readonly LoadedPlugin[]): void {
    if (this.disposed) return;
    const next = new Map<string, HostedPlugin>();
    let different = plugins.length !== this.hosted.size;
    for (const plugin of plugins) {
      const id = plugin.manifest.id;
      const old = this.hosted.get(id);
      if (old && old.plugin.hash === plugin.hash && old.session.active) {
        next.set(id, old);
        continue;
      }
      different = true;
      old?.session.revoke("The plugin changed or is no longer approved");
      next.set(id, {
        plugin,
        session: new PluginSession(
          bindingFor(this.options.vault, plugin.manifest, plugin.hash, this.actor),
        ),
      });
    }
    for (const [id, old] of this.hosted) {
      if (!next.has(id)) {
        different = true;
        old.session.revoke("The plugin is no longer enabled");
      }
    }
    this.hosted = next;
    for (const [id, frame] of this.background) {
      if (!next.has(id)) {
        frame.cleanup();
        this.background.delete(id);
      }
    }
    if (different) this.changed();
  }

  /** The person's rights changed (permissions arrived, or a role was edited): sessions are rebuilt. */
  setActor(actor: PluginActor): void {
    if (
      actor.read === this.actor.read &&
      actor.write === this.actor.write &&
      actor.propose === this.actor.propose
    )
      return;
    this.actor = actor;
    const plugins = this.list().map((entry) => entry.plugin);
    for (const entry of this.hosted.values())
      entry.session.revoke("The person's rights in this vault changed");
    this.hosted = new Map();
    this.setPlugins(plugins);
  }

  /** Draws one contribution of `pluginId` into `container`. */
  mount(container: HTMLElement, request: MountRequest): MountedFrame {
    const entry = this.hosted.get(request.pluginId);
    if (!entry || this.disposed) throw new Error(`Plugin ${request.pluginId} is not available`);
    const actions: HostActions = {
      openFile: this.options.openFile,
      showNotice: this.options.showNotice,
      ...(request.updateSource ? { updateSource: request.updateSource } : {}),
      invokeExtension: (point, input, signal) =>
        this.invokeExtension(request.pluginId, point, input, signal),
    };
    const frame = mountPlugin(container, {
      plugin: entry.plugin,
      session: entry.session,
      backend: (this.options.backend ?? ((id) => apiBackend(this.options.vault, id)))(
        request.pluginId,
      ),
      actions,
      notePath: request.notePath,
      mode: request.mode,
      target: request.target,
      context: request.context,
      locale: this.options.locale(),
      theme: this.options.theme(),
      onReady: request.onReady,
      onResize: request.onResize,
      onError: request.onError,
      onStopped: request.onStopped,
    });
    const tracked = { pluginId: request.pluginId, frame };
    this.live.add(tracked);
    return {
      ...frame,
      cleanup: () => {
        this.live.delete(tracked);
        frame.cleanup();
      },
    };
  }

  /** Enabled plugins that contribute to `point` of `providerId` and accept its version. */
  contributors(providerId: string, point: string): HostedPlugin[] {
    const provider = this.hosted.get(providerId);
    if (!provider) return [];
    const { version } = provider.plugin.manifest;
    return this.list().filter(({ plugin, session }) => {
      const { manifest } = plugin;
      return (
        manifest.id !== providerId &&
        session.active &&
        manifest.contributes.extensions.some(
          (use) => use.plugin === providerId && use.point === point,
        ) &&
        satisfiesVersion(version, manifest.dependencies[providerId])
      );
    });
  }

  /**
   * Asks each contributor in its own sandbox with only its own permissions: a contributor never
   * borrows the provider's. One failing or slow contributor does not fail the others.
   */
  async invokeExtension(
    providerId: string,
    point: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const data = plainData(input ?? null, "Extension input");
    const answers = await Promise.all(
      this.contributors(providerId, point).map(async ({ plugin }): Promise<ExtensionAnswer> => {
        const id = plugin.manifest.id;
        try {
          const frame = this.backgroundFrame(id);
          const result = await withTimeout(
            (inner) => frame.invoke(providerId, point, data, inner),
            EXTENSION_TIMEOUT_MS,
            signal,
          );
          return { plugin: id, result: plainData(result ?? null, "Extension result") };
        } catch (error) {
          return { plugin: id, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    return answers.filter((a) => a.error === undefined).map((a) => a.result);
  }

  /** One hidden frame per contributor, started on first use. */
  private backgroundFrame(pluginId: string): MountedFrame {
    const existing = this.background.get(pluginId);
    if (existing) return existing;
    if (!this.holder || !this.holder.isConnected) {
      this.holder = document.createElement("div");
      this.holder.className = "plugin-background";
      this.holder.setAttribute("aria-hidden", "true");
      this.holder.style.cssText =
        "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;";
      document.body.append(this.holder);
    }
    const slot = document.createElement("div");
    this.holder.append(slot);
    const mounted = this.mount(slot, {
      pluginId,
      mode: "background",
      target: "background",
      onStopped: () => {
        if (this.background.get(pluginId) === frame) this.background.delete(pluginId);
        slot.remove();
      },
    });
    const frame: MountedFrame = {
      ...mounted,
      cleanup: () => {
        mounted.cleanup();
        slot.remove();
      },
    };
    this.background.set(pluginId, frame);
    return frame;
  }

  /** A hidden frame for slot entries and other calls into a plugin that has no visible frame. */
  backgroundOf(pluginId: string): MountedFrame {
    return this.backgroundFrame(pluginId);
  }

  /** Delivers an event to every running frame whose plugin may hear about it. */
  emit(name: "file:changed", data: FileChangedEvent): void;
  emit(name: "file:opened", data: { path: string }): void;
  emit(name: "theme:changed", data: { theme: "light" | "dark" }): void;
  emit(name: "locale:changed", data: { locale: string }): void;
  emit(name: string, data: unknown): void {
    // Background frames are mounted through `mount`, so `live` already holds them.
    for (const { pluginId, frame } of this.live) {
      const entry = this.hosted.get(pluginId);
      if (!entry || !entry.session.active) continue;
      let payload: unknown = data;
      if (name === "file:changed") {
        payload = scopeFileEvent(entry.session.binding, data as FileChangedEvent);
      } else if (name === "file:opened") {
        payload = canRead(entry.session.binding, (data as { path: string }).path) ? data : null;
      } else if (name === "theme:changed") {
        payload = { ...(data as object), tokens: frameTokens() };
      } else if (name === "locale:changed") {
        payload = localeEvent(entry.plugin, (data as { locale: string }).locale);
      }
      if (payload !== null) frame.emit(name, payload);
    }
  }

  dispose(reason = "The vault was closed"): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.hosted.values()) entry.session.revoke(reason);
    for (const frame of this.background.values()) frame.cleanup();
    this.background.clear();
    this.live.clear();
    this.holder?.remove();
    this.listeners.clear();
  }
}

/** Aborts the call (dropping its pending state in the frame) when it times out or the caller cancels. */
function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  outer?.addEventListener("abort", cancel, { once: true });
  if (outer?.aborted) controller.abort();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("The extension did not answer in time"));
    }, ms);
    run(controller.signal)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        outer?.removeEventListener("abort", cancel);
      });
  });
}
