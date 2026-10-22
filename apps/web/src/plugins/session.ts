import { pathAllowed, type PluginManifest } from "@palimvo/plugin-sdk";

/** What the signed-in person may do in the vault; a plugin never gets more than this. */
export interface PluginActor {
  read: boolean;
  write: boolean;
  propose: boolean;
}

/** What the plugin was approved to do, fixed when its frame starts. Never sent to the frame. */
export interface PluginBinding {
  vault: string;
  pluginId: string;
  /** The hash a person approved. */
  hash: string;
  read: readonly string[];
  write: readonly string[];
  network: false | readonly string[];
  /** Points this plugin offers; only those may be invoked through it. */
  extensionPoints: readonly string[];
  actor: PluginActor;
}

export function bindingFor(
  vault: string,
  manifest: PluginManifest,
  hash: string,
  actor: PluginActor,
): PluginBinding {
  const { permissions, contributes } = manifest;
  return Object.freeze({
    vault,
    pluginId: manifest.id,
    hash,
    read: Object.freeze([...permissions.read]),
    write: Object.freeze([...permissions.write]),
    network: permissions.network === false ? false : Object.freeze([...permissions.network]),
    extensionPoints: Object.freeze(contributes.extensionPoints.map((point) => point.id)),
    actor: Object.freeze({ ...actor }),
  });
}

/** Whether the plugin may read `path` (a normalized vault path): declared folder and the person's own right. */
export function canRead(binding: PluginBinding, path: string): boolean {
  return binding.actor.read && pathAllowed(binding.read, path);
}

/** Writing needs the declared folder and the person's right to write (or, for a proposal, to propose). */
export function canWrite(binding: PluginBinding, path: string, proposal = false): boolean {
  const right = proposal ? binding.actor.propose || binding.actor.write : binding.actor.write;
  return right && pathAllowed(binding.write, path);
}

/**
 * The authority of one plugin in one vault for one signed-in person. Revoking it (approval
 * withdrawn, version changed, sign-out) stops every frame and pending call that holds it.
 */
export class PluginSession {
  private listeners = new Set<(reason: string) => void>();
  private reason: string | undefined;

  constructor(readonly binding: PluginBinding) {}

  get active(): boolean {
    return this.reason === undefined;
  }

  /** Throws when the authority was revoked. */
  assert(): void {
    if (this.reason !== undefined) throw new Error(this.reason);
  }

  /** Called at once if already revoked; returns a function that stops listening. */
  onRevoke(listener: (reason: string) => void): () => void {
    if (this.reason !== undefined) {
      listener(this.reason);
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  revoke(reason = "The plugin's authority was withdrawn"): void {
    if (this.reason !== undefined) return;
    this.reason = reason;
    for (const listener of this.listeners) {
      try {
        listener(reason);
      } catch {
        // One frame failing to clean up must not keep another frame's authority alive.
      }
    }
    this.listeners.clear();
  }
}
