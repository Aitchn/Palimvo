import { build } from "esbuild";
// @ts-expect-error -- plain script shared with `pnpm build`, no type declarations
import { bundleOptions } from "../scripts/bundle.mjs";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../src/errors.ts";
import { acquireLock, LOCK_FILE } from "../src/lock.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const exec = promisify(execFile);
let servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.dispose()));
  servers = [];
});
async function start(...args: Parameters<typeof startTestServer>) {
  const s = await startTestServer(...args);
  servers.push(s);
  return s;
}

describe("server", () => {
  it("reports health", async () => {
    const s = await start();
    const res = await s.fetch("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", version: expect.any(String) });
  });

  it("returns errors as {code, message}", async () => {
    const s = await start();
    const res = await s.fetch("/api/nope");
    expect(res.status).toBe(404);
    // Same answer with or without a built web app next to the server (the wording differs).
    expect(await res.json()).toEqual({ code: "not_found", message: expect.any(String) });
  });

  it("logs the effective configuration at startup", async () => {
    const s = await start();
    expect(s.logs.find((l) => l.msg === "starting palimvo")).toMatchObject({
      host: expect.any(String),
      port: expect.any(String),
    });
  });

  it("refuses a second server on the same data directory", async () => {
    const first = await start();
    await expect(startTestServer({ dataDir: first.dataDir })).rejects.toMatchObject({
      code: "already_running",
    });
    await expect(startTestServer({ dataDir: first.dataDir })).rejects.toBeInstanceOf(AppError);
  });

  it("takes over a lock left by a dead process", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "palimvo-lock-"));
    await writeFile(
      path.join(dir, LOCK_FILE),
      JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "then" }),
    );
    const s = await start({ dataDir: dir });
    expect((await s.fetch("/api/health")).status).toBe(200);
  });

  it("takes over a corrupt lock file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "palimvo-lock-"));
    await writeFile(path.join(dir, LOCK_FILE), "{half");
    const s = await start({ dataDir: dir });
    expect((await s.fetch("/api/health")).status).toBe(200);
  });

  it("lets only one of many concurrent starters take over a stale lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "palimvo-lock-"));
    await writeFile(
      path.join(dir, LOCK_FILE),
      JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "then" }),
    );
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(dir)));
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "already_running" });
    await won[0]?.value.release();
    await rm(dir, { recursive: true, force: true });
  });

  it("does not wait forever for a stuck shutdown hook", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "palimvo-hang-"));
    const s = await startTestServer({ dataDir: dir });
    s.onShutdown("stuck", () => new Promise(() => {}));
    await s.close();
    expect(s.logs.some((l) => l.msg === "shutdown hook failed" && l.hook === "stuck")).toBe(true);
    expect(existsSync(path.join(dir, LOCK_FILE))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("shuts down: runs hooks in reverse order, reports not ready, frees the lock and port", async () => {
    const s = await start();
    const order: string[] = [];
    let healthDuring: number | undefined;
    s.onShutdown("first", () => void order.push("first"));
    s.onShutdown("second", async () => {
      healthDuring = (await s.fetch("/api/health").catch(() => undefined))?.status;
      order.push("second");
    });
    s.onShutdown("broken", () => {
      throw new Error("boom");
    });
    await s.close();
    await s.close(); // idempotent
    expect(order).toEqual(["second", "first"]);
    expect([503, undefined]).toContain(healthDuring);
    expect(existsSync(path.join(s.dataDir, LOCK_FILE))).toBe(false);
    expect(s.logs.some((l) => l.msg === "shutdown hook failed")).toBe(true);
    await expect(s.fetch("/api/health")).rejects.toThrow();
    // The directory can be used again.
    servers.push(await startTestServer({ dataDir: s.dataDir }));
  });
});

describe("bundle", () => {
  it("runs from a clean directory with only node", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "palimvo-bundle-"));
    try {
      const bundle = path.join(cwd, "palimvo.mjs");
      await build({ ...bundleOptions(bundle), logLevel: "silent" });
      const { stdout } = await exec(process.execPath, [bundle, "version"], { cwd });
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

      const child = spawn(process.execPath, [bundle, "serve", "--port", "0", "--data-dir", "d"], {
        cwd,
      });
      const out = await new Promise<string>((resolve, reject) => {
        let buf = "";
        child.stdout.on("data", (d: Buffer) => {
          buf += d.toString();
          if (buf.includes('"msg":"listening"')) resolve(buf);
        });
        child.once("exit", (code) => reject(new Error(`exited ${code}: ${buf}`)));
      });
      const url = /"url":"([^"]+)"/.exec(out)?.[1];
      expect((await fetch(`${url}/api/health`)).status).toBe(200);

      const exited = new Promise<number | null>((r) => child.once("exit", r));
      child.kill("SIGTERM");
      if (process.platform !== "win32") expect(await exited).toBe(0);
      else await exited;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
