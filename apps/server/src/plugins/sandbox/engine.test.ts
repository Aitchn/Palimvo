// The security tests of the S2 spike (plan/palimvo/spikes/s2-plugin-sandbox.md §3), run against the
// engine in-process: what a plugin can and cannot do inside the QuickJS context.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openEngine, runTool, type Engine } from "./engine.ts";
import { SandboxError, type HostFunctions, type SandboxLimits } from "./limits.ts";

const files = new Map([
  ["a.md", "# A\nhello"],
  ["b.md", "# B\nworld"],
  ["decisions/d1.md", "---\nstatus: proposed\n---\nUse SQLite"],
]);
const audit: { author: string; path: string }[] = [];
/** Host functions receive whatever the plugin passed; the stubs here know their own shape. */
const typed = <A>(fn: (args: A) => unknown) => fn as (args: unknown) => unknown;
const host = (author = "plugin:decisions on behalf of ai:claude"): HostFunctions => ({
  read: typed(({ path }: { path: string }) => {
    if (!files.has(path)) throw new Error("not found: " + path);
    return files.get(path);
  }),
  list: typed(({ dir = "" }: { dir?: string }) =>
    [...files.keys()].filter((k) => k.startsWith(dir)),
  ),
  search: typed(({ q }: { q: string }) =>
    [...files].filter(([, v]) => v.includes(q)).map(([k]) => k),
  ),
  write: typed(({ path, content }: { path: string; content: string }) => {
    if (!path.startsWith("decisions/"))
      throw new Error("permission denied: write outside decisions/");
    files.set(path, content);
    audit.push({ author, path });
    return { ok: true };
  }),
});

const plugin = (body: string) => `globalThis.__plugin = { tools: { ${body} } };`;

let engine: Engine;
const engines: Engine[] = [];
const fresh = async (limits: Partial<SandboxLimits> = {}) => {
  const e = await openEngine({ wasmCapMB: 64, ...limits } as SandboxLimits);
  engines.push(e);
  return e;
};
beforeEach(async () => {
  // A call that ends badly poisons its engine; like the pool, never reuse it.
  if (!engine || engine.poisoned) engine = await fresh();
  files.set("a.md", "# A\nhello");
});
afterAll(() => {
  for (const e of engines) {
    try {
      e.runtime.dispose();
    } catch {
      // a poisoned heap may refuse to be disposed
    }
  }
});

const run = (
  src: string,
  tool: string,
  args: unknown = {},
  h: HostFunctions = host(),
  limits: Partial<SandboxLimits> = {},
) => runTool(engine, src, tool, args, h, limits);

async function expectKind(p: Promise<unknown>, ...kinds: string[]): Promise<SandboxError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SandboxError);
  expect(kinds, `${(err as SandboxError).kind}: ${(err as SandboxError).message}`).toContain(
    (err as SandboxError).kind,
  );
  return err as SandboxError;
}

describe("host API", () => {
  it("reads, lists, searches and writes through the host", async () => {
    const src = plugin(
      `record: async (a) => { const hits = await vault.search({q:'SQLite'}); const l = await vault.list({dir:'decisions/'}); await vault.write({path:'decisions/d2.md', content:'x '+a.title}); return {hits, l, n: (await vault.read({path:'a.md'})).length}; }`,
    );
    const r = await run(src, "record", { title: "T" });
    expect(r.result).toMatchObject({ hits: ["decisions/d1.md"], n: 9 });
    expect(audit.at(-1)?.path).toBe("decisions/d2.md");
    expect(r.hostCalls).toBe(4);
  });

  it("lets the plugin catch a host refusal", async () => {
    const src = plugin(
      `w: async () => { try { await vault.write({path:'a.md', content:'pwn'}); return 'wrote'; } catch (e) { return 'denied:' + e.message; } }`,
    );
    const r = await run(src, "w");
    expect(r.result).toMatch(/denied:.*permission denied/);
    expect(files.get("a.md")).toBe("# A\nhello");
  });

  it("returns console.log lines, at most 100", async () => {
    const src = plugin(
      `l: async () => { for (let i = 0; i < 150; i++) console.log('line', i); return 1; }`,
    );
    const r = await run(src, "l");
    expect(r.logs).toHaveLength(100);
    expect(r.logs[0]).toBe("line 0");
  });

  it("does not let host data with a __proto__ key poison the plugin's prototypes", async () => {
    const h = host();
    h.read = () => JSON.parse('{"__proto__":{"polluted":1}}');
    const src = plugin(
      `p: async () => { const o = await vault.read({}); return [({}).polluted ?? null, Object.keys(o)]; }`,
    );
    expect((await run(src, "p", {}, h)).result).toEqual([null, ["__proto__"]]);
  });
});

describe("no ambient authority", () => {
  it("has no fetch, require, process, timers, WebAssembly, ...", async () => {
    const src = plugin(
      `g: async () => ['fetch','require','process','module','Buffer','XMLHttpRequest','WebSocket','setTimeout','setInterval','queueMicrotask','WebAssembly','import','Deno','Bun','Atomics','document','window'].map(k => [k, typeof globalThis[k]]).filter(([, t]) => t !== 'undefined')`,
    );
    expect((await run(src, "g")).result).toEqual([]);
  });

  it("cannot import node:, file: or https: modules", async () => {
    const src = plugin(
      `i: async () => { const out = {}; for (const m of ['node:fs','fs','file:///etc/passwd','https://example.com/x.js']) { try { await import(m); out[m]='LOADED'; } catch (e) { out[m]='blocked'; } } return out; }`,
    );
    const r = await run(src, "i");
    expect(Object.values(r.result as object)).toEqual(Array(4).fill("blocked"));
  });

  it("cannot reach host objects through eval or the Function constructor", async () => {
    const src = plugin(
      `e: async () => { const g = (0,eval)('this'); const g2 = Function('return this')(); return [typeof g.process, typeof g2.require, g.constructor.constructor('return typeof process')()]; }`,
    );
    expect((await run(src, "e")).result).toEqual(["undefined", "undefined", "undefined"]);
  });

  it("starts every call in a fresh context: no globals or prototype changes carry over", async () => {
    const src = plugin(
      `p: async () => { const was = [typeof globalThis.leak, ({}).x ?? null]; globalThis.leak = 1; Object.prototype.x = 1; return was; }`,
    );
    expect((await run(src, "p")).result).toEqual(["undefined", null]);
    expect((await run(src, "p")).result).toEqual(["undefined", null]);
  });
});

describe("limits", () => {
  it("interrupts an infinite loop", async () => {
    const t0 = performance.now();
    await expectKind(
      run(plugin(`spin: async () => { while (true) {} }`), "spin", {}, host(), { timeoutMs: 300 }),
      "timeout",
    );
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("interrupts an endless microtask loop", async () => {
    const t0 = performance.now();
    await expectKind(
      run(
        plugin(`spin: async () => { for(;;) { await Promise.resolve(); } }`),
        "spin",
        {},
        host(),
        { timeoutMs: 300 },
      ),
      "timeout",
    );
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("times out a host call that never answers", async () => {
    const h = host();
    h.read = () => new Promise(() => {});
    await expectKind(
      run(plugin(`r: async () => vault.read({path:'a.md'})`), "r", {}, h, { timeoutMs: 300 }),
      "timeout",
    );
  });

  it("stops a memory bomb at the wasm ceiling and marks the engine poisoned", async () => {
    engine = await fresh({ wasmCapMB: 48 });
    const src = plugin(
      `m: async () => { const a = []; for(;;) a.push(new Array(10000).fill('x'.repeat(100))); }`,
    );
    await expectKind(
      run(src, "m", {}, host(), { memoryBytes: 8 * 1024 * 1024, timeoutMs: 3000 }),
      "memory",
      "engine",
    );
  });

  it("stops string doubling", async () => {
    engine = await fresh({ wasmCapMB: 48 });
    const src = plugin(`m: async () => { let s='xxxxxxxx'; for(;;) s = s + s; }`);
    await expectKind(
      run(src, "m", {}, host(), { memoryBytes: 8 * 1024 * 1024, timeoutMs: 3000 }),
      "tool",
      "memory",
      "engine",
    );
  });

  it("turns deep recursion into an error the plugin can see", async () => {
    const err = await expectKind(
      run(plugin(`r: async () => { const f = (n) => f(n + 1) + 1; return f(0); }`), "r"),
      "tool",
    );
    expect(err.message).toMatch(/stack|recursion/i);
    expect(engine.poisoned).toBe(false);
  });

  it("enforces the host call quota", async () => {
    const src = plugin(
      `f: async () => { for (let i=0;i<1000;i++) await vault.read({path:'a.md'}); }`,
    );
    await expectKind(run(src, "f", {}, host(), { maxHostCalls: 50 }), "tool");
  });

  it("refuses a result over the size limit", async () => {
    await expectKind(
      run(plugin(`b: async () => 'x'.repeat(2*1024*1024)`), "b", {}, host(), {
        maxResultBytes: 1024 * 1024,
      }),
      "result-too-large",
    );
  });
});

describe("errors", () => {
  it("reports a plugin exception and runs the next call normally", async () => {
    const src = plugin(`boom: async () => { throw new TypeError('bad'); }, ok: async () => 1`);
    const err = await expectKind(run(src, "boom"), "tool");
    expect(err.message).toMatch(/TypeError: bad/);
    expect((await run(src, "ok")).result).toBe(1);
  });

  it("reports a syntax error as a load error", async () => {
    await expectKind(run("globalThis.__plugin = {", "x"), "load");
  });

  it("reports an unknown tool", async () => {
    await expectKind(run(plugin(`a: async()=>1`), "zzz"), "tool");
  });

  it("copes with 50 parallel calls that wait on the host", async () => {
    // One runtime runs one call at a time; parallel callers each use their own engine, as the pool does.
    const src = plugin(
      `c: async (a) => { const x = await vault.read({path:'a.md'}); await vault.list({}); return a.i + x.length; }`,
    );
    const results = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const e = await fresh({ wasmCapMB: 16 });
        return runTool(e, src, "c", { i }, host());
      }),
    );
    results.forEach((r, i) => expect(r.result).toBe(i + 9));
  });
});
