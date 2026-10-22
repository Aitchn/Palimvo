// Runs inside a worker thread. Imports nothing from the rest of the server: the worker is bundled
// on its own, and a plugin must never be one import away from server code.
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import type {
  JSPromiseState,
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  DEFAULT_LIMITS,
  SandboxError,
  type HostFunctions,
  type SandboxLimits,
  type SandboxResult,
} from "./limits.ts";

/** Node has `WebAssembly`; the TypeScript setup here has no DOM library to type it. */
interface WasmApi {
  Memory: new (descriptor: { initial: number; maximum: number }) => object;
}

/** wasm pages are 64 KiB, so a megabyte is 16 of them. */
const PAGES_PER_MB = 16;

/**
 * One wasm module instance = one linear memory with a hard ceiling. QuickJS's own
 * `setMemoryLimit` is not a reliable cap in this build (allocations overshoot it and the heap can
 * be left inconsistent after an out-of-memory), so the ceiling is the wasm memory's `maximum`.
 */
export async function createEngine(capMB: number): Promise<QuickJSWASMModule> {
  const maximum = Math.max(1, Math.round(capMB * PAGES_PER_MB));
  const wasm = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;
  const memory = new wasm.Memory({ initial: Math.min(256, maximum), maximum });
  return newQuickJSWASMModuleFromVariant(
    newVariant(variant, { wasmMemory: memory as Parameters<typeof newVariant>[1]["wasmMemory"] }),
  );
}

/** An engine and its long-lived runtime. A call that fails in an unclean way sets `poisoned`. */
export interface Engine {
  module: QuickJSWASMModule;
  runtime: QuickJSRuntime;
  poisoned: boolean;
}

export async function openEngine(limits: SandboxLimits = DEFAULT_LIMITS): Promise<Engine> {
  const module = await createEngine(limits.wasmCapMB);
  return { module, runtime: module.newRuntime(), poisoned: false };
}

const errorText = (ctx: QuickJSContext, handle: QuickJSHandle): string => {
  const e = ctx.dump(handle) as unknown;
  handle.dispose();
  if (e && typeof e === "object") {
    const { name, message } = e as { name?: unknown; message?: unknown };
    return `${String(name)}: ${String(message)}`;
  }
  return String(e);
};

/** Builds a value inside the context with `JSON.parse`, so a `__proto__` key stays plain data. */
function jsonToHandle(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  const text = JSON.stringify(value === undefined ? null : value);
  const r = ctx.evalCode(`JSON.parse(${JSON.stringify(text)})`);
  if (r.error) {
    r.error.dispose();
    return ctx.undefined;
  }
  return r.value;
}

const classify = (message: string, fallback: "load" | "invoke" | "tool"): SandboxError => {
  if (/interrupted/i.test(message)) return new SandboxError("timeout", "tool exceeded time limit");
  if (/out of memory/i.test(message))
    return new SandboxError("memory", "tool exceeded memory limit");
  return new SandboxError(fallback === "invoke" ? "tool" : fallback, message);
};

/**
 * Runs one tool call: a fresh context on the long-lived runtime, the plugin's `server.js`
 * evaluated in it, the tool called, the context thrown away. Nothing a call does (globals,
 * `Object.prototype`) survives into the next.
 *
 * The plugin source defines `globalThis.__plugin = { tools: { name: async (args) => ... } }` and
 * sees only `vault` (host functions, all promises) and `console.log`.
 */
export async function runTool(
  engine: Engine,
  source: string,
  tool: string,
  args: unknown,
  host: HostFunctions,
  overrides: Partial<SandboxLimits> = {},
): Promise<SandboxResult> {
  const lim: SandboxLimits = { ...DEFAULT_LIMITS, ...overrides };
  const { runtime } = engine;
  runtime.setMemoryLimit(lim.memoryBytes);
  runtime.setMaxStackSize(lim.stackBytes);
  const deadline = Date.now() + lim.timeoutMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      interrupted = true;
      return true;
    }
    return false;
  });
  const ctx = runtime.newContext();
  const pending = new Set<{ dispose(): void }>();
  const logs: string[] = [];
  let hostCalls = 0;
  let timer: NodeJS.Timeout | undefined;
  let promise: QuickJSHandle | undefined;
  try {
    const vault = ctx.newObject();
    for (const name of Object.keys(host)) {
      const fn = ctx.newFunction(name, (argHandle) => {
        const deferred = ctx.newPromise();
        pending.add(deferred);
        void deferred.settled.then(() => {
          pending.delete(deferred);
          if (ctx.alive) runtime.executePendingJobs();
        });
        if (++hostCalls > lim.maxHostCalls) {
          const e = ctx.newError("host call quota exceeded");
          deferred.reject(e);
          e.dispose();
          return deferred.handle;
        }
        const a = ctx.dump(argHandle) as unknown;
        void Promise.resolve()
          .then(() => host[name]!(a))
          .then(
            (r) => {
              if (!ctx.alive) return;
              const h = jsonToHandle(ctx, r);
              deferred.resolve(h);
              if (h !== ctx.undefined) h.dispose();
            },
            (err: unknown) => {
              if (!ctx.alive) return;
              const h = ctx.newError(String((err as Error)?.message ?? err));
              deferred.reject(h);
              h.dispose();
            },
          );
        return deferred.handle;
      });
      ctx.setProp(vault, name, fn);
      fn.dispose();
    }
    ctx.setProp(ctx.global, "vault", vault);
    vault.dispose();

    const consoleObj = ctx.newObject();
    const logFn = ctx.newFunction("log", (...hs) => {
      if (logs.length < lim.maxLogLines)
        logs.push(
          hs
            .map((h) => String(ctx.dump(h) as unknown))
            .join(" ")
            .slice(0, 2000),
        );
    });
    ctx.setProp(consoleObj, "log", logFn);
    logFn.dispose();
    ctx.setProp(ctx.global, "console", consoleObj);
    consoleObj.dispose();

    const loaded = ctx.evalCode(source, "plugin/server.js");
    if (loaded.error) throw classify(errorText(ctx, loaded.error), "load");
    loaded.value.dispose();

    const call = ctx.evalCode(
      `(async()=>{const t=globalThis.__plugin&&globalThis.__plugin.tools&&globalThis.__plugin.tools[${JSON.stringify(tool)}];` +
        `if(typeof t!=="function")throw new Error("unknown tool");` +
        `const r=await t(JSON.parse(${JSON.stringify(JSON.stringify(args ?? null))}));` +
        `return JSON.stringify(r===undefined?null:r)})()`,
      "host/invoke.js",
    );
    if (call.error) throw classify(errorText(ctx, call.error), "invoke");
    promise = call.value;
    runtime.executePendingJobs();

    // Wait for the promise. The wall clock also covers a host call that never answers.
    let state: JSPromiseState = ctx.getPromiseState(promise);
    if (state.type === "pending") {
      state = await new Promise<JSPromiseState>((resolve, reject) => {
        timer = setTimeout(
          () => {
            interrupted = true;
            reject(new SandboxError("timeout", "tool exceeded wall-clock limit"));
          },
          Math.max(0, deadline - Date.now()),
        );
        const poll = () => {
          if (!ctx.alive) return reject(new SandboxError("engine", "context disposed"));
          try {
            runtime.executePendingJobs();
            const s = ctx.getPromiseState(promise!);
            if (s.type !== "pending") return resolve(s);
          } catch (e) {
            return reject(e instanceof Error ? e : new Error(String(e)));
          }
          setImmediate(poll);
        };
        // Host resolutions run pending jobs themselves; polling is the safety net.
        setImmediate(poll);
      });
    }
    if (state.type === "rejected") {
      const message = errorText(ctx, state.error);
      if (interrupted) throw new SandboxError("timeout", "tool exceeded time limit");
      throw classify(message, "tool");
    }
    if (state.type !== "fulfilled") throw new SandboxError("engine", "tool did not settle");
    const out = ctx.dump(state.value) as unknown;
    state.value.dispose();
    if (typeof out !== "string") throw new SandboxError("tool", "tool returned non-JSON");
    if (out.length > lim.maxResultBytes)
      throw new SandboxError("result-too-large", `The result is ${out.length} bytes.`);
    return { result: JSON.parse(out) as unknown, logs, hostCalls };
  } catch (e) {
    if (e instanceof SandboxError) throw e;
    if (interrupted) throw new SandboxError("timeout", "tool exceeded time limit");
    // A JavaScript exception from the wasm side (trap, abort, RangeError) means the heap may be damaged.
    engine.poisoned = true;
    throw new SandboxError("engine", String((e as Error)?.message ?? e));
  } finally {
    clearTimeout(timer);
    for (const d of pending) {
      try {
        d.dispose();
      } catch {
        // The context is going away anyway.
      }
    }
    try {
      if (promise?.alive) promise.dispose();
    } catch {
      // ditto
    }
    try {
      ctx.dispose();
    } catch {
      engine.poisoned = true;
    }
  }
}
