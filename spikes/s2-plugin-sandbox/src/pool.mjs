import { Worker } from "node:worker_threads";
import { SandboxError } from "./sandbox.mjs";
const entry = new URL("./pool-entry.mjs", import.meta.url);

/** Pool of long-lived sandbox workers. A worker that hit any limit/engine error is killed and replaced. */
export class SandboxPool {
  constructor(size = 4) { this.size = size; this.idle = []; this.queue = []; this.total = 0; this.spawned = 0; }
  _spawn() {
    this.total++; this.spawned++;
    const w = new Worker(entry, { resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    const slot = { w, ready: new Promise((res) => w.once("message", (m) => m.type === "ready" && res())) };
    w.on("error", () => {}); // surfaced via the per-call handlers
    return slot;
  }
  async warm() { while (this.total < this.size) this.idle.push(this._spawn()); await Promise.all(this.idle.map((s) => s.ready)); }
  async _acquire() {
    if (this.idle.length) return this.idle.pop();
    if (this.total < this.size) return this._spawn();
    return new Promise((res) => this.queue.push(res));
  }
  _release(slot, kill) {
    if (kill) { slot.w.terminate(); this.total--; if (this.queue.length) this.queue.shift()(this._spawn()); return; }
    if (this.queue.length) this.queue.shift()(slot); else this.idle.push(slot);
  }
  async run(source, tool, args, host, limits = {}) {
    const slot = await this._acquire(); await slot.ready;
    const timeoutMs = limits.timeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (kill, fn) => { if (settled) return; settled = true; clearTimeout(hard); slot.w.off("message", onMsg); slot.w.off("error", onErr); this._release(slot, kill); fn(); };
      const hard = setTimeout(() => done(true, () => reject(new SandboxError("timeout", "worker killed (hard timeout)"))), timeoutMs + 300);
      const onErr = (e) => done(true, () => reject(new SandboxError("engine", String(e.message))));
      const onMsg = async (m) => {
        if (m.type === "host") {
          try { const value = await host.vault[m.name](m.args); if (!settled) slot.w.postMessage({ type: "hostResult", id: m.id, value }); }
          catch (e) { if (!settled) slot.w.postMessage({ type: "hostResult", id: m.id, error: String(e.message ?? e) }); }
        } else if (m.type === "done") done(m.poisoned, () => (m.ok ? resolve({ result: m.result, hostCalls: m.hostCalls }) : reject(new SandboxError(m.kind, m.message))));
      };
      slot.w.on("message", onMsg); slot.w.on("error", onErr);
      slot.w.postMessage({ type: "call", source, tool, args, limits, hostFns: Object.keys(host.vault) });
    });
  }
  async close() { await Promise.all([...this.idle].map((s) => s.w.terminate())); }
}
