// Minimal plugin-tool sandbox on quickjs-emscripten (sync WASM build + host promises).
import { newQuickJSWASMModule, newVariant, RELEASE_SYNC } from "quickjs-emscripten";

export const DEFAULT_LIMITS = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  timeoutMs: 5000, // wall clock for the whole call, host waits included
  cpuSliceMs: 1000, // not used separately; interrupt handler checks the wall deadline
  maxHostCalls: 200,
  maxResultBytes: 1024 * 1024,
  wasmCapMB: 64, // hard ceiling of the instance's linear memory
};

/**
 * One wasm module instance = one linear memory. The memory has a HARD ceiling
 * (WebAssembly.Memory maximum), because QuickJS's own setMemoryLimit is not a
 * reliable cap in this build (see report): allocations can overshoot it and the
 * heap can be left inconsistent after an OOM. A poisoned instance is simply dropped.
 */
export async function createEngine(capMB = 64) {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: capMB * 16 }); // 16 MB initial, 64 KiB pages
  return newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
}
export const loadEngine = () => createEngine(64);

/**
 * Run one plugin tool call.
 * @param {string} source   plugin server.js (CommonJS-ish: defines `tools` on globalThis.__plugin)
 * @param {string} tool     tool name
 * @param {any} args        JSON-able arguments
 * @param {object} host     { vault: { read, list, search, write } } host-side async impls (already permission-scoped)
 * @param {object} limits
 * @param {object} [pool]   optional { runtime } to reuse a runtime
 */
export async function runTool(source, tool, args, host, limits = {}, pool = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const QuickJS = pool.engine ?? (await createEngine(lim.wasmCapMB));
  const runtime = pool.runtime ?? QuickJS.newRuntime();
  runtime.setMemoryLimit(lim.memoryBytes);
  runtime.setMaxStackSize(lim.stackBytes);
  const deadline = Date.now() + lim.timeoutMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) { interrupted = true; return true; }
    return false;
  });
  const ctx = runtime.newContext();
  const pending = new Set();
  let hostCalls = 0;
  let timer, promiseHandle;
  try {
    // ---- host bridge: each vault.* is a promise-returning function, JSON in / JSON out ----
    const vault = ctx.newObject();
    for (const name of Object.keys(host.vault)) {
      const fn = ctx.newFunction(name, (argHandle) => {
        const deferred = ctx.newPromise();
        pending.add(deferred);
        deferred.settled.then(() => { pending.delete(deferred); if (ctx.alive) runtime.executePendingJobs(); });
        if (++hostCalls > lim.maxHostCalls) {
          const e = ctx.newError("host call quota exceeded");
          deferred.reject(e); e.dispose();
          return deferred.handle;
        }
        const a = ctx.dump(argHandle);
        Promise.resolve().then(() => host.vault[name](a)).then(
          (r) => { if (!ctx.alive) return; const h = jsonToHandle(ctx, r); deferred.resolve(h); h.dispose(); },
          (err) => { if (!ctx.alive) return; const h = ctx.newError(String(err?.message ?? err)); deferred.reject(h); h.dispose(); },
        );
        return deferred.handle;
      });
      ctx.setProp(vault, name, fn);
      fn.dispose();
    }
    ctx.setProp(ctx.global, "vault", vault);
    vault.dispose();
    // minimal console that goes nowhere (no host I/O)
    const logs = [];
    const consoleObj = ctx.newObject();
    const logFn = ctx.newFunction("log", (...hs) => { if (logs.length < 100) logs.push(hs.map((h) => String(ctx.dump(h))).join(" ")); });
    ctx.setProp(consoleObj, "log", logFn); logFn.dispose();
    ctx.setProp(ctx.global, "console", consoleObj); consoleObj.dispose();

    // plugin load
    const loaded = ctx.evalCode(source, "plugin/server.js");
    if (loaded.error) { const m = dumpErr(ctx, loaded.error); throw new SandboxError(/interrupted/.test(m) ? "timeout" : /out of memory/.test(m) ? "memory" : "load", m); }
    loaded.value.dispose();

    // invoke: wrapper returns a promise resolving to JSON string
    const call = ctx.evalCode(
      `(async()=>{const t=globalThis.__plugin&&globalThis.__plugin.tools&&globalThis.__plugin.tools[${JSON.stringify(tool)}];` +
      `if(typeof t!=="function")throw new Error("unknown tool");const r=await t(${JSON.stringify(args ?? null)});return JSON.stringify(r===undefined?null:r)})()`,
      "host/invoke.js",
    );
    if (call.error) { const m = dumpErr(ctx, call.error); throw new SandboxError(/interrupted/.test(m) ? "timeout" : "invoke", m); }
    promiseHandle = call.value;
    runtime.executePendingJobs();

    // wait for settle (host-side wall clock; also covers hung host calls)
    const state = ctx.getPromiseState(promiseHandle);
    let final = state;
    if (state.type === "pending") {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => { interrupted = true; reject(new SandboxError("timeout", "tool exceeded wall-clock limit")); }, Math.max(0, deadline - Date.now()));
        const poll = () => {
          if (!ctx.alive) return reject(new SandboxError("disposed", "context gone"));
          runtime.executePendingJobs();
          const s = ctx.getPromiseState(promiseHandle);
          if (s.type !== "pending") { final = s; return resolve(); }
          setImmediate(poll);
        };
        // poll mostly as a safety net; host resolutions already call executePendingJobs()
        setImmediate(poll);
      });
    }
    if (final.type === "rejected") {
      const msg = dumpErr(ctx, final.error);
      promiseHandle.dispose(); promiseHandle = undefined;
      if (interrupted || /interrupted/.test(msg)) throw new SandboxError("timeout", "tool exceeded time limit");
      if (/out of memory/.test(msg)) throw new SandboxError("memory", "tool exceeded memory limit");
      throw new SandboxError("tool", msg);
    }
    const out = ctx.dump(final.value);
    final.value?.dispose?.();
    promiseHandle.dispose(); promiseHandle = undefined;
    if (typeof out !== "string") throw new SandboxError("tool", "tool returned non-JSON");
    if (out.length > lim.maxResultBytes) throw new SandboxError("result-too-large", `${out.length} bytes`);
    return { result: JSON.parse(out), logs, hostCalls, memoryUsed: undefined };
  } catch (e) {
    if (e instanceof SandboxError) throw e;
    if (interrupted) throw new SandboxError("timeout", "tool exceeded time limit");
    // A host-side exception from wasm (trap, abort, RangeError) means the instance is poisoned.
    pool.poisoned = true;
    throw new SandboxError("engine", String(e?.message ?? e));
  } finally {
    clearTimeout(timer);
    for (const d of pending) { try { d.dispose(); } catch {} }
    try { if (promiseHandle?.alive) promiseHandle.dispose(); } catch {}
    try { ctx.dispose(); } catch {}
    if (!pool.runtime) { try { runtime.dispose(); } catch {} }
  }
}

export class SandboxError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
function dumpErr(ctx, h) { const e = ctx.dump(h); h.dispose(); return e && typeof e === "object" ? `${e.name}: ${e.message}` : String(e); }
function jsonToHandle(ctx, v) {
  const r = ctx.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(v === undefined ? null : v))})`);
  if (r.error) { r.error.dispose(); return ctx.undefined; }
  return r.value;
}
