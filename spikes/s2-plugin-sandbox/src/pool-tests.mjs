import assert from "node:assert/strict";
import { SandboxPool } from "./pool.mjs";

const mk = (b) => `globalThis.__plugin={tools:{${b}}};`;
const host = { vault: { read: async () => "hello", list: async () => [], search: async () => [], write: async () => ({ ok: true }) } };
const pool = new SandboxPool(2);
await pool.warm();
const out = [];
async function t(name, fn) { try { await fn(); out.push(`✔ ${name}`); } catch (e) { out.push(`✘ ${name}: ${e.message}`); process.exitCode = 1; } }
async function maxStall(fn) {
  let max = 0, last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; }, 5);
  const err = await fn().catch((e) => e);
  await new Promise((r) => setTimeout(r, 20)); clearInterval(iv);
  return { err, max };
}

await t("warm call returns result", async () => assert.equal((await pool.run(mk("e: async(a)=>a.n+1"), "e", { n: 1 }, host)).result, 2));
await t("CPU spinner: timeout, main thread not blocked (<100 ms), pool recovers", async () => {
  const { err, max } = await maxStall(() => pool.run(mk("s: async()=>{for(;;){}}"), "s", {}, host, { timeoutMs: 400 }));
  assert.equal(err.kind, "timeout"); assert.ok(max < 100, `stall ${max}`);
  assert.equal((await pool.run(mk("e: async()=>'ok'"), "e", {}, host)).result, "ok");
});
await t("catastrophic regex: timeout without blocking main", async () => {
  const { err, max } = await maxStall(() => pool.run(mk("r: async()=>/(a+)+$/.test('a'.repeat(60)+'b')"), "r", {}, host, { timeoutMs: 300 }));
  assert.equal(err.kind, "timeout"); assert.ok(max < 100, `stall ${max}`);
});
await t("memory bomb: memory error, main thread unaffected, pool recovers", async () => {
  const { err, max } = await maxStall(() => pool.run(mk("m: async()=>{const a=[];for(;;)a.push(new Array(10000).fill(1))}"), "m", {}, host, { timeoutMs: 5000, wasmCapMB: 96 }));
  assert.ok(["memory", "tool", "engine"].includes(err.kind), err.kind); assert.ok(max < 150, `stall ${max}`);
  assert.equal((await pool.run(mk("e: async()=>'ok'"), "e", {}, host)).result, "ok");
});
await t("hung host call: hard timeout, worker replaced", async () => {
  const hung = { vault: { ...host.vault, read: () => new Promise(() => {}) } };
  const { err } = await maxStall(() => pool.run(mk("r: async()=>vault.read({})"), "r", {}, hung, { timeoutMs: 300 }));
  assert.equal(err.kind, "timeout");
  assert.equal((await pool.run(mk("e: async()=>'ok'"), "e", {}, host)).result, "ok");
});
await t("no state leaks between calls on a recycled worker", async () => {
  await pool.run(mk("p: async()=>{ globalThis.leak='secret'; Object.prototype.z=1; return 1 }"), "p", {}, host);
  const b = await pool.run(mk("p: async()=>[typeof globalThis.leak, ({}).z]"), "p", {}, host);
  assert.deepEqual(b.result, ["undefined", null]);
});
await t("host permission errors surface to the plugin through the worker bridge", async () => {
  const strict = { vault: { ...host.vault, write: async () => { throw new Error("permission denied"); } } };
  const r = await pool.run(mk("w: async()=>{ try { await vault.write({}); return 'wrote' } catch (e) { return e.message } }"), "w", {}, strict);
  assert.match(r.result, /permission denied/);
});
console.log(out.join("\n"));
await pool.close();
process.exit(process.exitCode ?? 0);
