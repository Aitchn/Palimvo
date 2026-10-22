// Evidence for ADR: QuickJS setMemoryLimit() alone is not a reliable cap in the wasm build;
// a hard WebAssembly.Memory maximum is. Prints, per hostile snippet, how far memory actually grew.
import { getQuickJS, newQuickJSWASMModule, newVariant, RELEASE_SYNC } from "quickjs-emscripten";

const cases = {
  "push 10k-element arrays": "const a=[]; for(;;) a.push(new Array(10000).fill(1))",
  "push 1 MB typed arrays": "const a=[]; for(;;) a.push(new Uint8Array(1e6))",
  "Map growth": "const m=new Map(); for(let i=0;;i++) m.set(i,i)",
  "object key growth": "const o={}; for(let i=0;;i++) o['k'+i]=i",
  "small objects": "const a=[]; for(;;) a.push({a:1})",
};
const LIMIT = 8 << 20;

async function attempt(Q, code, deadlineMs) {
  const rt = Q.newRuntime();
  rt.setMemoryLimit(LIMIT);
  rt.setMaxStackSize(256 << 10);
  const dl = Date.now() + deadlineMs;
  rt.setInterruptHandler(() => Date.now() > dl);
  const ctx = rt.newContext();
  const t0 = Date.now();
  let outcome = "ok";
  let used = "n/a";
  try {
    const r = ctx.evalCode(code);
    if (r.error) { const e = ctx.dump(r.error); outcome = e?.message || "error"; r.error.dispose(); } else r.value.dispose();
    try { const u = rt.computeMemoryUsage(); const h = ctx.getProp(u, "memory_used_size"); used = (ctx.dump(h) / 1048576).toFixed(0) + " MB"; h.dispose(); u.dispose(); }
    catch (e) { used = "computeMemoryUsage trapped: " + String(e.message).slice(0, 40); }
  } catch (e) { outcome = "HOST EXCEPTION " + String(e.message).slice(0, 50); }
  try { ctx.dispose(); rt.dispose(); } catch (e) { outcome += " (dispose threw)"; }
  return `${outcome.padEnd(34)} ${String(Date.now() - t0).padStart(5)} ms  qjs-reported use: ${used}`;
}

console.log(`setMemoryLimit = ${LIMIT >> 20} MB in both columns; deadline 1.5 s\n`);
const plain = await getQuickJS();
for (const [name, code] of Object.entries(cases)) {
  console.log(name.padEnd(26), "[limit only]   ", await attempt(plain, code, 1500));
  const capped = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: 64 * 16 }) }));
  console.log("".padEnd(26), "[+64MB wasm cap]", await attempt(capped, code, 1500));
}
