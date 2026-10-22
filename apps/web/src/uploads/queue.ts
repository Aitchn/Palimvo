import { useSyncExternalStore } from "react";

export type UploadState = "uploading" | "done" | "failed";

export interface UploadEntry {
  id: number;
  name: string;
  total: number;
  sent: number;
  state: UploadState;
  /** Already translated text, set when `state` is "failed". */
  error?: string;
}

export interface UploadHandle {
  readonly signal: AbortSignal;
  progress(sent: number): void;
  done(): void;
  fail(error: string): void;
  /** The person stopped it: take it off the list at once. */
  cancelled(): void;
}

/**
 * The uploads the person has started in this tab, for the progress panel. Finished ones stay
 * listed for a few seconds so a quick upload is still seen.
 */
class UploadQueue {
  private entries: UploadEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<number, AbortController>();
  private next = 1;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): readonly UploadEntry[] => this.entries;

  start(name: string, total: number): UploadHandle {
    const id = this.next++;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.update([...this.entries, { id, name, total, sent: 0, state: "uploading" }]);
    const patch = (change: Partial<UploadEntry>) =>
      this.update(this.entries.map((e) => (e.id === id ? { ...e, ...change } : e)));
    const finish = (change: Partial<UploadEntry>, keepMs: number) => {
      this.controllers.delete(id);
      patch(change);
      setTimeout(() => this.update(this.entries.filter((e) => e.id !== id)), keepMs);
    };
    return {
      signal: controller.signal,
      progress: (sent) => patch({ sent }),
      done: () => finish({ state: "done", sent: total }, 3000),
      fail: (error) => finish({ state: "failed", error }, 15_000),
      cancelled: () => {
        this.controllers.delete(id);
        this.dismiss(id);
      },
    };
  }

  /** Stops an upload that is still sending. */
  cancel(id: number): void {
    this.controllers.get(id)?.abort();
  }

  dismiss(id: number): void {
    this.update(this.entries.filter((e) => e.id !== id));
  }

  private update(entries: UploadEntry[]): void {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}

export const uploadQueue = new UploadQueue();

export function useUploads(): readonly UploadEntry[] {
  return useSyncExternalStore(uploadQueue.subscribe, uploadQueue.snapshot);
}
