import { SandboxPool } from "./pool.mjs";
import { runTool } from "./sandbox.mjs";
const mk = (b) => `globalThis.__plugin={tools:{${b}}};`;
const host = { vault: { read: async () => "hello", list: async () => [], search: async () => [], write: async () => ({ok:true}) } };
const q = (a, p) => { const s = [...a].sort((x,y)=>x-y); return s[Math.floor(s.length*p)]; };
async function bench(label, n, fn) { for (let i=0;i<10;i++) await fn(); const ts=[]; for (let i=0;i<n;i++){const t=performance.now(); await fn(); ts.push(performance.now()-t);} console.log(label.padEnd(56),"p50",q(ts,.5).toFixed(2)+"ms","p95",q(ts,.95).toFixed(2)+"ms"); }
const pool = new SandboxPool(4); const t0 = performance.now(); await pool.warm(); console.log("pool warm-up (4 workers):", (performance.now()-t0).toFixed(0), "ms");
await bench("pool warm worker, echo", 200, () => pool.run(mk("echo: async(a)=>a"), "echo", {x:1}, host));
await bench("pool warm worker, 1 host call", 200, () => pool.run(mk("rd: async()=>(await vault.read({path:'a'})).length"), "rd", {}, host));
const par = performance.now(); await Promise.all(Array.from({length:200},()=>pool.run(mk("rd: async()=>(await vault.read({path:'a'})).length"), "rd", {}, host))); console.log("200 parallel calls through 4 workers:", (performance.now()-par).toFixed(0), "ms total");

async function stall(label, fn) {
  let maxGap = 0, last = performance.now(); const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 5);
  const e = await fn().catch((e) => e); await new Promise((r) => setTimeout(r, 20)); clearInterval(iv);
  console.log(label.padEnd(44), "->", e.kind ?? "ok", "| max main-thread stall", maxGap.toFixed(0), "ms");
}
await stall("spinner, in-process", () => runTool(mk("s: async()=>{for(;;){}}"), "s", {}, host, { timeoutMs: 400 }));
await stall("spinner, worker pool", () => pool.run(mk("s: async()=>{for(;;){}}"), "s", {}, host, { timeoutMs: 400 }));
await stall("memory bomb, worker pool", () => pool.run(mk("m: async()=>{const a=[];for(;;)a.push(new Array(10000).fill(1))}"), "m", {}, host, { timeoutMs: 3000, wasmCapMB: 96 }));
// after kills, pool still works
console.log("after kills, pool spawned", pool.spawned, "workers total; healthy call:", JSON.stringify((await pool.run(mk("e: async()=>'ok'"), "e", {}, host)).result));
// hung host call hard-kill
const hung = { vault: { ...host.vault, read: () => new Promise(() => {}) } };
await stall("hung host call, worker pool", () => pool.run(mk("r: async()=>vault.read({})"), "r", {}, hung, { timeoutMs: 300 }));
// isolation of state across calls in a recycled runtime
const a = await pool.run(mk("p: async()=>{ const had = globalThis.leak; globalThis.leak='secret'; Object.prototype.z=1; return had===undefined && ({}).z===1 }"), "p", {}, host);
const b = await pool.run(mk("p: async()=>{ return [typeof globalThis.leak, ({}).z] }"), "p", {}, host);
console.log("cross-call leakage after pollution:", JSON.stringify(b.result), "(expect [\"undefined\",null])");
await pool.close(); process.exit(0);
