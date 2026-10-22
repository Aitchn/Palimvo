// The worker pool tests of the S2 spike, plus recycling, queueing and shutdown.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxError, type HostFunctions } from "./limits.ts";
import { SandboxPool, type PoolEvent } from "./pool.ts";

const mk = (body: string) => `globalThis.__plugin={tools:{${body}}};`;
const host: HostFunctions = {
  read: () => "hello",
  list: () => [],
  search: () => [],
  write: () => ({ ok: true }),
};

let pool: SandboxPool;
let events: PoolEvent[];
beforeEach(async () => {
  events = [];
  pool = new SandboxPool({ size: 2, wasmCapMB: 96, onEvent: (e) => events.push(e) });
  await pool.warm();
});
afterEach(() => pool.close());

/** The longest the main thread was blocked while `fn` ran, measured with a 5 ms ticker. */
async function maxStall<T>(fn: () => Promise<T>) {
  let max = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e as SandboxError,
  );
  await new Promise((r) => setTimeout(r, 20));
  clearInterval(iv);
  return { err, max };
}

const ok = async () =>
  expect((await pool.run(mk("e: async()=>'ok'"), "e", {}, host)).result).toBe("ok");

describe("SandboxPool", () => {
  it("is warm after warm(): workers exist before the first call", () => {
    expect(pool.stats()).toMatchObject({ workers: 2, idle: 2, spawned: 2, discarded: 0 });
  });

  it("returns results from a warm worker", async () => {
    const r = await pool.run(mk("e: async(a)=>a.n+1"), "e", { n: 1 }, host);
    expect(r.result).toBe(2);
  });

  it("stops a CPU spinner without blocking the main thread, and keeps serving", async () => {
    const { err, max } = await maxStall(() =>
      pool.run(mk("s: async()=>{for(;;){}}"), "s", {}, host, { timeoutMs: 400 }),
    );
    expect(err?.kind).toBe("timeout");
    expect(max).toBeLessThan(250);
    await ok();
  });

  it("stops catastrophic regex backtracking", async () => {
    const { err, max } = await maxStall(() =>
      pool.run(mk("r: async()=>/(a+)+$/.test('a'.repeat(60)+'b')"), "r", {}, host, {
        timeoutMs: 300,
      }),
    );
    expect(err?.kind).toBe("timeout");
    expect(max).toBeLessThan(250);
    await ok();
  });

  it("survives a memory bomb: other calls are unaffected and the worker is replaced", async () => {
    const before = pool.stats().discarded;
    const { err, max } = await maxStall(() =>
      pool.run(
        mk("m: async()=>{const a=[];for(;;)a.push(new Array(10000).fill(1))}"),
        "m",
        {},
        host,
        {
          timeoutMs: 5000,
        },
      ),
    );
    expect(["memory", "tool", "engine"]).toContain(err?.kind);
    expect(max).toBeLessThan(500);
    await ok();
    expect(pool.stats().discarded).toBeGreaterThan(before);
    expect(events.some((e) => e.type === "discarded" && e.reason === "poisoned")).toBe(true);
  });

  it("kills a worker whose host call never answers", async () => {
    const hung: HostFunctions = { ...host, read: () => new Promise(() => {}) };
    const { err } = await maxStall(() =>
      pool.run(mk("r: async()=>vault.read({})"), "r", {}, hung, { timeoutMs: 300 }),
    );
    expect(err?.kind).toBe("timeout");
    await ok();
  });

  it("does not let one plugin's trouble touch calls running at the same time", async () => {
    const slow = pool.run(
      mk("w: async()=>{ for (let i=0;i<20;i++) await vault.read({}); return 'done' }"),
      "w",
      {},
      { ...host, read: () => new Promise((r) => setTimeout(() => r("x"), 10)) },
    );
    const bad = pool.run(mk("s: async()=>{for(;;){}}"), "s", {}, host, { timeoutMs: 300 });
    await expect(bad).rejects.toMatchObject({ kind: "timeout" });
    expect((await slow).result).toBe("done");
  });

  it("starts no state on a recycled worker: globals and prototypes do not leak", async () => {
    await pool.run(
      mk("p: async()=>{ globalThis.leak='secret'; Object.prototype.z=1; return 1 }"),
      "p",
      {},
      host,
    );
    const b = await pool.run(
      mk("p: async()=>[typeof globalThis.leak, ({}).z ?? null]"),
      "p",
      {},
      host,
    );
    expect(b.result).toEqual(["undefined", null]);
  });

  it("shows host refusals to the plugin through the worker bridge", async () => {
    const strict: HostFunctions = {
      ...host,
      write: () => {
        throw new Error("permission denied");
      },
    };
    const r = await pool.run(
      mk(
        "w: async()=>{ try { await vault.write({}); return 'wrote' } catch (e) { return e.message } }",
      ),
      "w",
      {},
      strict,
    );
    expect(r.result).toMatch(/permission denied/);
  });

  it("queues calls beyond the worker count and answers them all", async () => {
    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        pool.run(mk("c: async(a)=>{ await vault.read({}); return a.i }"), "c", { i }, host),
      ),
    );
    expect(rs.map((r) => r.result)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(pool.stats().workers).toBe(2);
  });

  it("refuses calls when the queue is full", async () => {
    await pool.close();
    pool = new SandboxPool({ size: 1, maxQueue: 1 });
    await pool.warm();
    const hung: HostFunctions = {
      ...host,
      read: () => new Promise((r) => setTimeout(() => r("x"), 150)),
    };
    const src = mk("r: async()=>vault.read({})");
    const a = pool.run(src, "r", {}, hung);
    const b = pool.run(src, "r", {}, hung);
    await expect(pool.run(src, "r", {}, hung)).rejects.toMatchObject({ kind: "busy" });
    await Promise.all([a, b]);
  });

  it("replaces a worker after the configured number of calls", async () => {
    await pool.close();
    events = [];
    pool = new SandboxPool({ size: 1, recycleAfterCalls: 3, onEvent: (e) => events.push(e) });
    await pool.warm();
    for (let i = 0; i < 7; i++) await pool.run(mk("e: async()=>1"), "e", {}, host);
    expect(events.filter((e) => e.type === "discarded" && e.reason === "recycled")).toHaveLength(2);
    expect(pool.stats().workers).toBe(1);
  });

  it("replaces idle workers once they are older than the recycle age", async () => {
    await pool.close();
    events = [];
    pool = new SandboxPool({ size: 1, recycleAfterMs: 100, onEvent: (e) => events.push(e) });
    await pool.warm();
    await new Promise((r) => setTimeout(r, 400));
    expect(events.some((e) => e.type === "discarded" && e.reason === "recycled")).toBe(true);
    await expect(pool.run(mk("e: async()=>1"), "e", {}, host)).resolves.toMatchObject({
      result: 1,
    });
  });

  it("rejects waiting and new calls after close", async () => {
    await pool.close();
    await expect(pool.run(mk("e: async()=>1"), "e", {}, host)).rejects.toBeInstanceOf(SandboxError);
  });
});
