import { runTool, createEngine } from "./sandbox.mjs";
const small = `globalThis.__plugin={tools:{echo:async(a)=>a, rd:async()=>{const t=await vault.read({path:'a.md'});return t.length}}};`;
// ~120KB "bundled" plugin: lots of dead helper code + the tool
const filler = Array.from({length: 1500}, (_, i) => `function helper${i}(x){ const o = {k:${i}, v:x, arr:[1,2,3,${i}]}; return JSON.stringify(o) + "${"y".repeat(40)}"; }`).join("\n");
const big = filler + "\n" + small;
const host = { vault: { read: async () => "hello world".repeat(100), list: async () => [], search: async () => [], write: async () => ({ok:true}) } };
const q = (a, p) => { const s = [...a].sort((x,y)=>x-y); return s[Math.floor(s.length*p)]; };
async function bench(label, n, fn) {
  for (let i = 0; i < 5; i++) await fn(); // warmup
  const ts = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
  console.log(label.padEnd(58), "p50", q(ts,.5).toFixed(2)+"ms", "p95", q(ts,.95).toFixed(2)+"ms", "max", Math.max(...ts).toFixed(1)+"ms");
}
console.log("plugin source sizes: small", small.length, "B, big", (big.length/1024).toFixed(0), "KB");
const t0 = performance.now(); const E = await createEngine(64); console.log("first engine create", (performance.now()-t0).toFixed(1), "ms");
await bench("createEngine only (wasm instantiate, 64MB cap)", 50, async () => { await createEngine(64); });
await bench("A. fresh engine+runtime+ctx per call, small, echo", 100, () => runTool(small, "echo", {x:1}, host));
await bench("A. fresh engine+runtime+ctx per call, big(120KB), echo", 100, () => runTool(big, "echo", {x:1}, host));
await bench("A. fresh ... small, 1 host call", 100, () => runTool(small, "rd", {}, host));
const eng = await createEngine(64); const rt = eng.newRuntime();
await bench("B. shared engine+runtime, new ctx per call, small", 300, () => runTool(small, "echo", {x:1}, host, {}, { engine: eng, runtime: rt }));
await bench("B. shared engine+runtime, new ctx per call, big(120KB)", 300, () => runTool(big, "echo", {x:1}, host, {}, { engine: eng, runtime: rt }));
await bench("B. shared, small, 1 host call", 300, () => runTool(small, "rd", {}, host, {}, { engine: eng, runtime: rt }));
rt.dispose();

// idle footprint of N resident engines
global.gc?.();
const rss0 = process.memoryUsage().rss; const keep = [];
for (let i = 0; i < 20; i++) { const e = await createEngine(64); const r = e.newRuntime(); const c = r.newContext(); keep.push([e, r, c]); }
console.log("RSS for 20 idle resident (engine+runtime+ctx):", ((process.memoryUsage().rss - rss0) / 1048576).toFixed(1), "MB  =>", ((process.memoryUsage().rss - rss0) / 20 / 1048576).toFixed(2), "MB each");
for (const [, r, c] of keep) { c.dispose(); r.dispose(); }

// leak check: many fresh-engine calls
global.gc?.();
const r1 = process.memoryUsage().rss;
for (let i = 0; i < 500; i++) await runTool(small, "rd", {}, host);
global.gc?.();
console.log("RSS growth after 500 fresh-engine calls:", ((process.memoryUsage().rss - r1) / 1048576).toFixed(1), "MB");
const r2 = process.memoryUsage().rss;
const eng2 = await createEngine(64); const rt2 = eng2.newRuntime();
for (let i = 0; i < 3000; i++) await runTool(small, "rd", {}, host, {}, { engine: eng2, runtime: rt2 });
console.log("RSS growth after 3000 shared-runtime calls:", ((process.memoryUsage().rss - r2) / 1048576).toFixed(1), "MB");
