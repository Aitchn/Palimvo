import { parentPort } from "node:worker_threads";
import { runTool, createEngine } from "./sandbox.mjs";
const engine = await createEngine(96);
const runtime = engine.newRuntime();
const pool = { engine, runtime };
let nextId = 1; const waiting = new Map();
const proxyFor = (fns) => ({ vault: Object.fromEntries(fns.map((name) => [name, (args) => new Promise((resolve, reject) => {
  const id = nextId++; waiting.set(id, { resolve, reject }); parentPort.postMessage({ type: "host", id, name, args });
})])) });
parentPort.on("message", async (m) => {
  if (m.type === "hostResult") { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.value); return; }
  if (m.type === "call") {
    try { const r = await runTool(m.source, m.tool, m.args, proxyFor(m.hostFns), m.limits, pool); parentPort.postMessage({ type: "done", ok: true, result: r.result, hostCalls: r.hostCalls }); }
    catch (e) { parentPort.postMessage({ type: "done", ok: false, kind: e.kind ?? "engine", message: String(e.message), poisoned: !!pool.poisoned || ["timeout","memory","engine"].includes(e.kind) }); }
  }
});
parentPort.postMessage({ type: "ready" });
