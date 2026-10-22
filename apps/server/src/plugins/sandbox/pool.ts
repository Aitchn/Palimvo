import { Worker } from "node:worker_threads";
import {
  DEFAULT_LIMITS,
  HARD_TIMEOUT_GRACE_MS,
  SandboxError,
  type HostFunctions,
  type SandboxLimits,
  type SandboxResult,
} from "./limits.ts";
import type { FromWorker, ToWorker, WorkerData } from "./protocol.ts";
import { workerSource } from "./workerSource.ts";

export interface PoolOptions {
  /** Long-lived workers (`PALIMVO_PLUGIN_WORKERS`). */
  size?: number;
  /** Retire a worker after this many calls, so a slow leak never builds up. */
  recycleAfterCalls?: number;
  /** ... or after this long. */
  recycleAfterMs?: number;
  /** Calls waiting for a worker; more are refused with `busy`. */
  maxQueue?: number;
  /** Hard wasm memory ceiling of each worker. */
  wasmCapMB?: number;
  /** Defaults for every call. */
  limits?: Partial<SandboxLimits>;
  /** Override where the worker code comes from (tests). */
  workerFile?: URL;
  onEvent?: (event: PoolEvent) => void;
}

export type PoolEvent =
  | { type: "spawned"; reason: "warm" | "demand" | "replace" | "recycle" }
  | { type: "discarded"; reason: "poisoned" | "recycled" | "crashed" };

export interface PoolStats {
  size: number;
  workers: number;
  idle: number;
  queued: number;
  spawned: number;
  discarded: number;
}

interface Slot {
  worker: Worker;
  ready: Promise<void>;
  calls: number;
  born: number;
  dead: boolean;
}

export const DEFAULT_WORKERS = 4;
const SWEEP_MS = 30_000;

const sourceFile = import.meta.url.endsWith(".ts");

/**
 * A fixed number of long-lived worker threads, each with one wasm instance (hard memory ceiling)
 * and one QuickJS runtime. A tool call gets a worker for its whole duration; the main thread
 * never runs plugin code, so a spinning plugin cannot stall the server.
 *
 * A worker that timed out, ran out of memory, hit an engine fault or died is **discarded** (never
 * reused) and replaced; healthy ones are retired after `recycleAfterCalls` calls or
 * `recycleAfterMs`. Calls beyond the worker count wait in a queue.
 */
export class SandboxPool {
  readonly size: number;
  private readonly opts: Required<Omit<PoolOptions, "workerFile" | "onEvent" | "limits">> & {
    limits: SandboxLimits;
    workerFile?: URL;
    onEvent?: (e: PoolEvent) => void;
  };
  private readonly idle: Slot[] = [];
  private readonly queue: { resolve(s: Slot): void; reject(e: Error): void }[] = [];
  private readonly all = new Set<Slot>();
  private spawned = 0;
  private discarded = 0;
  private closed = false;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(options: PoolOptions = {}) {
    this.size = Math.max(1, Math.floor(options.size ?? DEFAULT_WORKERS));
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.opts = {
      size: this.size,
      recycleAfterCalls: options.recycleAfterCalls ?? 500,
      recycleAfterMs: options.recycleAfterMs ?? 10 * 60_000,
      maxQueue: options.maxQueue ?? 256,
      wasmCapMB: options.wasmCapMB ?? limits.wasmCapMB,
      limits,
      ...(options.workerFile ? { workerFile: options.workerFile } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    };
  }

  stats(): PoolStats {
    return {
      size: this.size,
      workers: this.all.size,
      idle: this.idle.length,
      queued: this.queue.length,
      spawned: this.spawned,
      discarded: this.discarded,
    };
  }

  /** Starts every worker and resolves when all are ready. Done at server start, not on a request. */
  async warm(): Promise<void> {
    this.startSweeper();
    while (this.all.size < this.size && !this.closed) this.idle.push(this.spawn("warm"));
    await Promise.all(this.idle.map((s) => s.ready.catch(() => undefined)));
  }

  /** Runs one tool call in a worker. Rejects with a {@link SandboxError}. */
  async run(
    source: string,
    tool: string,
    args: unknown,
    host: HostFunctions,
    limits: Partial<SandboxLimits> = {},
  ): Promise<SandboxResult> {
    if (this.closed) throw new SandboxError("engine", "The plugin sandbox is shut down.");
    this.startSweeper();
    const merged = { ...this.opts.limits, ...limits };
    // The queue wait is not part of the call's time.
    const slot = await this.acquire();
    try {
      await slot.ready;
    } catch (e) {
      this.discard(slot, "crashed");
      throw new SandboxError("engine", `Sandbox worker did not start: ${String(e)}`);
    }
    slot.calls++;
    return new Promise<SandboxResult>((resolve, reject) => {
      const { worker } = slot;
      let settled = false;
      const finish = (poisoned: boolean, then: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        this.release(slot, poisoned);
        then();
      };
      const hard = setTimeout(
        () =>
          finish(true, () =>
            reject(new SandboxError("timeout", "Tool did not finish in time and was stopped.")),
          ),
        merged.timeoutMs + HARD_TIMEOUT_GRACE_MS,
      );
      const onError = (e: Error) =>
        finish(true, () => reject(new SandboxError("engine", String(e.message))));
      const onExit = () =>
        finish(true, () => reject(new SandboxError("engine", "Sandbox worker stopped.")));
      const onMessage = (m: FromWorker) => {
        if (m.type === "host") {
          if (settled) return;
          const fn = host[m.name];
          const reply = (msg: ToWorker) => {
            if (!settled) worker.postMessage(msg);
          };
          if (!fn) {
            reply({ type: "hostResult", id: m.id, error: `unknown host function ${m.name}` });
            return;
          }
          void Promise.resolve()
            .then(() => fn(m.args))
            .then(
              (value) => reply({ type: "hostResult", id: m.id, value }),
              (e: unknown) =>
                reply({
                  type: "hostResult",
                  id: m.id,
                  error: String((e as Error)?.message ?? e),
                }),
            );
        } else if (m.type === "done") {
          finish(m.poisoned, () =>
            m.ok
              ? resolve({ result: m.result, logs: m.logs, hostCalls: m.hostCalls })
              : reject(new SandboxError(m.kind, m.message)),
          );
        }
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      const call: ToWorker = {
        type: "call",
        source,
        tool,
        args,
        limits: merged,
        hostFns: Object.keys(host),
      };
      worker.postMessage(call);
    });
  }

  /** Stops every worker; waiting calls are rejected. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const w of this.queue.splice(0))
      w.reject(new SandboxError("engine", "Sandbox shut down."));
    await Promise.all([...this.all].map((s) => this.kill(s)));
    this.all.clear();
    this.idle.length = 0;
  }

  // ---- workers --------------------------------------------------------------------------------

  private spawn(reason: "warm" | "demand" | "replace" | "recycle"): Slot {
    this.spawned++;
    this.opts.onEvent?.({ type: "spawned", reason });
    const data: WorkerData = { wasmCapMB: this.opts.wasmCapMB };
    const options = {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    };
    const worker =
      this.opts.workerFile !== undefined
        ? new Worker(this.opts.workerFile, options)
        : sourceFile || workerSource === undefined
          ? new Worker(new URL("./worker.ts", import.meta.url), options)
          : new Worker(workerSource, { ...options, eval: true });
    const slot: Slot = {
      worker,
      calls: 0,
      born: Date.now(),
      dead: false,
      ready: new Promise<void>((resolve, reject) => {
        const onMessage = (m: FromWorker) => {
          if (m.type !== "ready") return;
          worker.off("message", onMessage);
          resolve();
        };
        worker.on("message", onMessage);
        worker.once("error", reject);
        worker.once("exit", () => reject(new Error("worker exited before it was ready")));
      }),
    };
    slot.ready.catch(() => undefined);
    // Errors while a call runs are reported through that call's handlers; an idle worker that dies is replaced.
    worker.on("error", () => undefined);
    worker.on("exit", () => {
      slot.dead = true;
      if (!this.all.has(slot)) return;
      const i = this.idle.indexOf(slot);
      if (i >= 0) {
        this.idle.splice(i, 1);
        this.discard(slot, "crashed");
        this.refill();
      }
    });
    this.all.add(slot);
    return slot;
  }

  private async acquire(): Promise<Slot> {
    for (;;) {
      const slot = this.idle.pop();
      if (!slot) break;
      if (!slot.dead) return slot;
    }
    if (this.all.size < this.size) return this.spawn("demand");
    if (this.queue.length >= this.opts.maxQueue)
      throw new SandboxError("busy", "Too many plugin tool calls are waiting. Try again shortly.");
    return new Promise<Slot>((resolve, reject) => this.queue.push({ resolve, reject }));
  }

  private release(slot: Slot, poisoned: boolean): void {
    const age = Date.now() - slot.born;
    const worn = slot.calls >= this.opts.recycleAfterCalls || age >= this.opts.recycleAfterMs;
    if (poisoned || worn || slot.dead) {
      this.discard(slot, poisoned ? "poisoned" : slot.dead ? "crashed" : "recycled");
      if (!this.closed) this.refill(poisoned ? "replace" : "recycle");
      return;
    }
    const waiter = this.queue.shift();
    if (waiter) waiter.resolve(slot);
    else this.idle.push(slot);
  }

  /** Replaces discarded workers: for a waiting call first, otherwise to keep the pool warm. */
  private refill(reason: "replace" | "recycle" = "replace"): void {
    while (!this.closed && this.all.size < this.size) {
      const slot = this.spawn(reason);
      const waiter = this.queue.shift();
      if (waiter) waiter.resolve(slot);
      else this.idle.push(slot);
    }
  }

  private discard(slot: Slot, reason: "poisoned" | "recycled" | "crashed"): void {
    if (!this.all.delete(slot)) return;
    this.discarded++;
    this.opts.onEvent?.({ type: "discarded", reason });
    const i = this.idle.indexOf(slot);
    if (i >= 0) this.idle.splice(i, 1);
    void this.kill(slot);
  }

  private async kill(slot: Slot): Promise<void> {
    slot.dead = true;
    await slot.worker.terminate().catch(() => 0);
  }

  /** Idle workers older than the recycle age are replaced even when nothing is calling. */
  private startSweeper(): void {
    if (this.sweeper || this.closed) return;
    this.sweeper = setInterval(
      () => {
        const now = Date.now();
        for (const slot of [...this.idle])
          if (now - slot.born >= this.opts.recycleAfterMs) {
            this.discard(slot, "recycled");
            this.refill("recycle");
          }
      },
      Math.min(SWEEP_MS, Math.max(50, this.opts.recycleAfterMs / 2)),
    );
    this.sweeper.unref();
  }
}
