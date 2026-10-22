import assert from "node:assert/strict";
import { runTool, loadEngine, SandboxError } from "./sandbox.mjs";

const files = new Map([["a.md", "# A\nhello"], ["b.md", "# B\nworld"], ["decisions/d1.md", "---\nstatus: proposed\n---\nUse SQLite"]]);
const audit = [];
const host = (author = "plugin:decisions on behalf of ai:claude") => ({
  vault: {
    read: async ({ path }) => { if (!files.has(path)) throw new Error("not found: " + path); return files.get(path); },
    list: async ({ dir = "" }) => [...files.keys()].filter((k) => k.startsWith(dir)),
    search: async ({ q }) => [...files].filter(([, v]) => v.includes(q)).map(([k]) => k),
    write: async ({ path, content }) => {
      if (!path.startsWith("decisions/")) throw new Error("permission denied: write outside decisions/");
      files.set(path, content); audit.push({ author, path }); return { ok: true };
    },
  },
});

const results = [];
async function t(name, fn) {
  const t0 = performance.now();
  try { await fn(); results.push([name, "PASS", (performance.now() - t0).toFixed(1)]); }
  catch (e) { results.push([name, "FAIL " + e.message, (performance.now() - t0).toFixed(1)]); }
}
const plugin = (body) => `globalThis.__plugin = { tools: { ${body} } };`;
const expectKind = async (p, kind) => { try { await p; } catch (e) { assert.ok(e instanceof SandboxError, "not SandboxError: " + e); assert.equal(e.kind, kind, `${e.kind}: ${e.message}`); return e; } assert.fail("did not throw"); };


await t("happy path: read/list/search/write via host API", async () => {
  const src = plugin(`record: async (a) => { const hits = await vault.search({q:'SQLite'}); const l = await vault.list({dir:'decisions/'}); await vault.write({path:'decisions/d2.md', content:'x '+a.title}); return {hits, l, n: (await vault.read({path:'a.md'})).length}; }`);
  const r = await runTool(src, "record", { title: "T" }, host());
  assert.deepEqual(r.result.hits, ["decisions/d1.md"]); assert.equal(r.result.n, 9);
  assert.equal(audit.at(-1).path, "decisions/d2.md");
});
await t("host denies write outside permitted dir; error reaches plugin as catchable", async () => {
  const src = plugin(`w: async () => { try { await vault.write({path:'a.md', content:'pwn'}); return 'wrote'; } catch (e) { return 'denied:' + e.message; } }`);
  const r = await runTool(src, "w", {}, host());
  assert.match(r.result, /denied:.*permission denied/); assert.equal(files.get("a.md"), "# A\nhello");
});
await t("no ambient authority: fetch/require/process/fs/XMLHttpRequest/setTimeout/WebAssembly absent", async () => {
  const src = plugin(`g: async () => ['fetch','require','process','module','Buffer','XMLHttpRequest','WebSocket','setTimeout','setInterval','queueMicrotask','WebAssembly','import','Deno','Bun','Atomics'].map(k => [k, typeof globalThis[k]])`);
  const r = await runTool(src, "g", {}, host());
  const present = r.result.filter(([, ty]) => ty !== "undefined");
  assert.deepEqual(present, [], JSON.stringify(present));
});
await t("dynamic import() of node: / file: / http: fails", async () => {
  const src = plugin(`i: async () => { const out = {}; for (const m of ['node:fs','fs','file:///etc/passwd','https://example.com/x.js']) { try { await import(m); out[m]='LOADED'; } catch (e) { out[m]='blocked'; } } return out; }`);
  const r = await runTool(src, "i", {}, host());
  for (const v of Object.values(r.result)) assert.equal(v, "blocked");
});
await t("Function-constructor / eval escape cannot reach host objects", async () => {
  const src = plugin(`e: async () => { const g = (0,eval)('this'); const g2 = Function('return this')(); return [typeof g.process, typeof g2.require, g.constructor.constructor('return typeof process')()]; }`);
  const r = await runTool(src, "e", {}, host());
  assert.deepEqual(r.result, ["undefined", "undefined", "undefined"]);
});
await t("infinite CPU loop is interrupted by time limit", async () => {
  const src = plugin(`spin: async () => { while (true) {} }`);
  const t0 = performance.now();
  await expectKind(runTool(src, "spin", {}, host(), { timeoutMs: 300 }), "timeout");
  const dt = performance.now() - t0; assert.ok(dt < 1500, "took " + dt);
});
await t("infinite microtask loop (promise chain) is interrupted", async () => {
  const src = plugin(`spin: async () => { for(;;) { await Promise.resolve(); } }`);
  const t0 = performance.now();
  await expectKind(runTool(src, "spin", {}, host(), { timeoutMs: 300 }), "timeout");
  assert.ok(performance.now() - t0 < 2000);
});
await t("hung host call (never resolves) hits wall-clock limit", async () => {
  const h = host(); h.vault.read = () => new Promise(() => {});
  const src = plugin(`r: async () => vault.read({path:'a.md'})`);
  await expectKind(runTool(src, "r", {}, h, { timeoutMs: 300 }), "timeout");
});
await t("memory bomb (array growth) hits memory limit, host survives", async () => {
  const src = plugin(`m: async () => { const a = []; for(;;) a.push(new Array(10000).fill('x'.repeat(100))); }`);
  await expectKind(runTool(src, "m", {}, host(), { memoryBytes: 8 * 1024 * 1024, timeoutMs: 3000, wasmCapMB: 48 }), "memory");
});
await t("string doubling bomb hits memory limit", async () => {
  const src = plugin(`m: async () => { let s='xxxxxxxx'; for(;;) s = s + s; }`);
  await expectKind(runTool(src, "m", {}, host(), { memoryBytes: 8 * 1024 * 1024, timeoutMs: 3000, wasmCapMB: 48 }), "tool");
});
await t("deep recursion -> stack overflow is a catchable plugin error", async () => {
  const src = plugin(`r: async () => { const f = (n) => f(n + 1) + 1; return f(0); }`);
  const e = await expectKind(runTool(src, "r", {}, host()), "tool");
  assert.match(e.message, /stack|recursion/i);
});
await t("plugin exception is isolated and reported; next call works", async () => {
  const src = plugin(`boom: async () => { throw new TypeError('bad'); }, ok: async () => 1`);
  const e = await expectKind(runTool(src, "boom", {}, host()), "tool"); assert.match(e.message, /TypeError: bad/);
  assert.equal((await runTool(src, "ok", {}, host())).result, 1);
});
await t("syntax error in plugin source -> load error", async () => {
  await expectKind(runTool("globalThis.__plugin = {", "x", {}, host()), "load");
});
await t("unknown tool -> tool error", async () => { await expectKind(runTool(plugin(`a: async()=>1`), "zzz", {}, host()), "tool"); });
await t("host-call quota (flood) is enforced", async () => {
  const src = plugin(`f: async () => { for (let i=0;i<1000;i++) await vault.read({path:'a.md'}); }`);
  await expectKind(runTool(src, "f", {}, host(), { maxHostCalls: 50 }), "tool");
});
await t("oversized result rejected", async () => {
  const src = plugin(`b: async () => 'x'.repeat(2*1024*1024)`);
  await expectKind(runTool(src, "b", {}, host(), { maxResultBytes: 1024 * 1024 }), "result-too-large");
});
await t("host data with __proto__ key can't poison plugin prototypes", async () => {
  const h = host(); h.vault.read = async () => JSON.parse('{"__proto__":{"polluted":1}}');
  const src = plugin(`p: async () => { const o = await vault.read({}); return [({}).polluted, Object.keys(o)]; }`);
  const r = await runTool(src, "p", {}, h); assert.equal(r.result[0], null); assert.deepEqual(r.result[1], ["__proto__"]);
});
await t("prototype pollution inside plugin does not leak across calls (fresh context)", async () => {
  const src = plugin(`p: async () => { const was = ({}).x; Object.prototype.x = 1; return was; }`);
  assert.equal((await runTool(src, "p", {}, host())).result, null);
  assert.equal((await runTool(src, "p", {}, host())).result, null);
});
await t("concurrency: 50 parallel calls with host awaits", async () => {
  const src = plugin(`c: async (a) => { const x = await vault.read({path:'a.md'}); await vault.list({}); return a.i + x.length; }`);
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => runTool(src, "c", { i }, host())));
  rs.forEach((r, i) => assert.equal(r.result, i + 9));
});
await t("one spinning call doesn't stop siblings forever (single-thread caveat measured)", async () => {
  const spin = plugin(`s: async () => { while(true){} }`), ok = plugin(`o: async () => 'fine'`);
  const t0 = performance.now();
  const [a, b] = await Promise.allSettled([runTool(spin, "s", {}, host(), { timeoutMs: 400 }), runTool(ok, "o", {}, host())]);
  assert.equal(a.status, "rejected"); assert.equal(b.status, "fulfilled");
  results.push(["(info) call that spins finished in", "PASS", (performance.now() - t0).toFixed(0)]);
});

console.log(results.map((r) => `${r[1].startsWith("PASS") ? "✔" : "✘"} ${r[0]}  [${r[1]}] ${r[2]}ms`).join("\n"));
process.exit(results.some((r) => r[1].startsWith("FAIL")) ? 1 : 0);
