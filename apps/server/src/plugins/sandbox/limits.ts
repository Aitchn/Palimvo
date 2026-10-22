/** What one tool call may use. The pool applies the defaults; callers may tighten them. */
export interface SandboxLimits {
  /** QuickJS's own heap limit. Not reliable alone (see `wasmCapMB`), but it makes ordinary overuse a clean error. */
  memoryBytes: number;
  /** 256 KB at most: a larger stack lets the wasm run into V8's own limit and poisons the engine. */
  stackBytes: number;
  /** Wall clock for the whole call, host calls included. The worker is killed 300 ms after it. */
  timeoutMs: number;
  /** Host function calls (`vault.*`) one tool call may make. */
  maxHostCalls: number;
  /** Size of the JSON a tool may return. */
  maxResultBytes: number;
  /** `console.log` lines returned to the caller as debug information. */
  maxLogLines: number;
  /** Hard ceiling of a worker's wasm linear memory: the only memory limit that cannot be exceeded. */
  wasmCapMB: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  timeoutMs: 5000,
  maxHostCalls: 200,
  maxResultBytes: 1024 * 1024,
  maxLogLines: 100,
  wasmCapMB: 64,
};

/** The soft (in-engine) timeout is followed by a hard `worker.terminate()` after this much longer. */
export const HARD_TIMEOUT_GRACE_MS = 300;

export type SandboxErrorKind =
  /** Out of time (soft or hard). The worker was or will be thrown away. */
  | "timeout"
  /** Out of memory. The worker is thrown away. */
  | "memory"
  /** The plugin's source did not load (syntax error, exception while loading). */
  | "load"
  /** The tool threw, does not exist, or broke a limit that leaves the engine healthy (calls, stack). */
  | "tool"
  | "result-too-large"
  /** The engine itself failed (wasm trap, abort). The worker is thrown away. */
  | "engine"
  /** The pool had no room for the call. */
  | "busy";

export class SandboxError extends Error {
  readonly kind: SandboxErrorKind;
  constructor(kind: SandboxErrorKind, message: string) {
    super(message);
    this.name = "SandboxError";
    this.kind = kind;
  }
}

/** The host functions a plugin sees as `vault.<name>`: JSON in, JSON out. */
export type HostFunctions = Record<string, (args: unknown) => Promise<unknown> | unknown>;

export interface SandboxResult {
  result: unknown;
  /** `console.log` output, capped. */
  logs: string[];
  hostCalls: number;
}
