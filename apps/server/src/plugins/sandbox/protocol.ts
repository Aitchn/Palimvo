import type { SandboxErrorKind, SandboxLimits } from "./limits.ts";

/** Messages between the pool (main thread) and a sandbox worker. */
export type ToWorker =
  | {
      type: "call";
      source: string;
      tool: string;
      args: unknown;
      limits: Partial<SandboxLimits>;
      hostFns: string[];
    }
  | { type: "hostResult"; id: number; value?: unknown; error?: string };

export type FromWorker =
  | { type: "ready" }
  | { type: "host"; id: number; name: string; args: unknown }
  | {
      type: "done";
      ok: true;
      result: unknown;
      logs: string[];
      hostCalls: number;
      poisoned: boolean;
    }
  | {
      type: "done";
      ok: false;
      kind: SandboxErrorKind;
      message: string;
      poisoned: boolean;
    };

export interface WorkerData {
  wasmCapMB: number;
}
