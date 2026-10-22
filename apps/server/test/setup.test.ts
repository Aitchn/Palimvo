import { access, readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLocalRequest } from "../src/auth/setup.ts";
import { defaultConfig, isLoopbackHost, loadConfig } from "../src/config/index.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const PASSWORD = "correct horse battery";
let server: TestServer | undefined;

afterEach(async () => {
  await server?.dispose();
  server = undefined;
});

const start = async () => (server = await startTestServer({ devInsecure: false }));
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

/** What a reverse proxy on the same machine adds: the request is not typed on this machine. */
const REMOTE = { "x-forwarded-for": "203.0.113.9" };

const post = (s: TestServer, body: unknown, headers: Record<string, string> = {}) =>
  s.fetch("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const account = { username: "root", password: PASSWORD };

const tokenPath = (s: TestServer) => path.join(s.dataDir, "setup-token");
const readCode = async (s: TestServer) => (await readFile(tokenPath(s), "utf8")).trim();
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe("setup mode", () => {
  it("writes the code to a file and the log, and answers only the setup endpoints", async () => {
    const s = await start();
    const code = await readCode(s);
    expect(code).toMatch(/^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/);
    expect(s.logs.find((l) => l.msg === "first-time setup required")).toMatchObject({
      setupCode: code,
    });

    expect(await json(await s.fetch("/api/auth/me"))).toEqual({ state: "setup" });
    expect((await s.fetch("/api/health")).status).toBe(200);
    for (const p of ["/api/vaults", "/api/vaults/main/files", "/api/admin/users"]) {
      const res = await s.fetch(p);
      expect(res.status, p).toBe(403);
      expect(await json(res)).toMatchObject({ code: "setup_required" });
    }
    const write = await s.fetch("/api/vaults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x" }),
    });
    expect(write.status).toBe(403);
    expect(await s.services.vaults.listVaults()).toEqual([]);
  });

  it("keeps the same code across a restart", async () => {
    const s = await start();
    const code = await readCode(s);
    const dataDir = s.dataDir;
    await s.close();
    server = await startTestServer({ devInsecure: false, dataDir });
    expect(await readCode(server)).toBe(code);
  });

  it("reports whether the caller needs the code", async () => {
    const s = await start();
    expect(await json(await s.fetch("/api/setup/status"))).toEqual({
      required: true,
      needsCode: false,
    });
    expect(await json(await s.fetch("/api/setup/status", { headers: REMOTE }))).toEqual({
      required: true,
      needsCode: true,
    });
  });
});

describe("POST /api/setup", () => {
  it("lets a request from this machine in without the code", async () => {
    const s = await start();
    const res = await post(s, { ...account, displayName: "Root", vault: { id: "main" } });
    expect(res.status).toBe(201);
    const body = await json<{ account: Record<string, unknown>; csrfToken: string; vault: string }>(
      res,
    );
    expect(body.account).toMatchObject({
      username: "root",
      displayName: "Root",
      serverAdmin: true,
    });
    expect(body.account).not.toHaveProperty("passwordHash");
    expect(body.vault).toBe("main");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("palimvo_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);

    // The new session works: signed in as the administrator.
    const me = await json(
      await s.fetch("/api/auth/me", { headers: { cookie: cookie.split(";")[0]! } }),
    );
    expect(me).toMatchObject({ state: "account", account: { username: "root" } });
    const list = await json<{ vaults: { id: string }[] }>(
      await s.fetch("/api/vaults", { headers: { cookie: cookie.split(";")[0]! } }),
    );
    expect(list.vaults.map((v) => v.id)).toEqual(["main"]);
  });

  it("needs the code from anywhere else, and a wrong code changes nothing", async () => {
    const s = await start();
    const none = await post(s, account, REMOTE);
    expect(none.status).toBe(403);
    expect(await json(none)).toMatchObject({ code: "setup_code_required" });
    const wrong = await post(s, { ...account, code: "AAAA-AAAA-AAAA-AAAA" }, REMOTE);
    expect(wrong.status).toBe(403);
    expect(s.store.accounts.count()).toBe(0);
    expect(await s.services.vaults.listVaults()).toEqual([]);

    const code = await readCode(s);
    // Case and dashes do not matter when typing the code.
    const ok = await post(s, { ...account, code: code.toLowerCase().replaceAll("-", " ") }, REMOTE);
    expect(ok.status).toBe(201);
  });

  it("blocks guessing the code", async () => {
    const s = await start();
    for (let i = 0; i < 10; i++)
      expect((await post(s, { ...account, code: "BBBB-BBBB-BBBB-BBBB" }, REMOTE)).status).toBe(403);
    const blocked = await post(s, { ...account, code: await readCode(s) }, REMOTE);
    expect(blocked.status).toBe(429);
    expect(s.store.accounts.count()).toBe(0);
  });

  it("is refused for a proxied request even from a loopback socket", async () => {
    const s = await start();
    const proxied: Record<string, string>[] = [
      { "x-forwarded-for": "198.51.100.1" },
      { "x-real-ip": "198.51.100.1" },
      { forwarded: "for=198.51.100.1" },
      { "cf-connecting-ip": "198.51.100.1" },
    ];
    for (const headers of proxied) expect((await post(s, account, headers)).status).toBe(403);
    expect(s.store.accounts.count()).toBe(0);
  });

  it("needs the code on a non-loopback address of this machine", async (ctx) => {
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.family === "IPv4")?.address;
    if (!external) return ctx.skip();
    const s = await startTestServer({ devInsecure: false, host: "0.0.0.0" });
    server = s;
    const url = `http://${external}:${s.port}/api/setup`;
    const body = JSON.stringify({ ...account });
    const headers = { "content-type": "application/json" };
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(403);
    const withCode = JSON.stringify({ ...account, code: await readCode(s) });
    expect((await fetch(url, { method: "POST", headers, body: withCode })).status).toBe(201);
  });

  it("creates the default roles, the vault membership and an audit entry", async () => {
    const s = await start();
    await post(s, { ...account, vault: { id: "main" } });
    const roles = s.store.roles.list();
    expect(roles.map((r) => r.name)).toEqual(["Reader", "AI user", "Creator", "@everyone"]);
    expect(roles.find((r) => r.isEveryone)?.permissions).toBe(0);
    const admin = s.store.accounts.getByUsername("root")!;
    expect(s.store.accounts.getMember("main", admin.id)?.position).toBe("admin");
    expect(s.store.settings.get("setup.completedAt")).toBeTypeOf("number");
    expect(s.store.audit.query({ action: "setup.completed" })).toHaveLength(1);
  });

  it("creates the first vault, with sample notes only when asked", async () => {
    const plain = await start();
    await post(plain, { ...account, vault: { id: "plain" } });
    const files = await plain.services.vaults.listFiles("plain");
    expect(files).toEqual(["Welcome.md"]);
    await plain.dispose();

    server = await startTestServer({ devInsecure: false });
    await post(server, { ...account, vault: { id: "demo", sample: true } });
    const demo = await server.services.vaults.listFiles("demo");
    expect(demo).toEqual(
      expect.arrayContaining(["Welcome.md", "Getting started.md", "Example board.canvas"]),
    );
    // The sample content is in the first commit, not left as an uncommitted change.
    const commits = await server.services.history.list("demo", { path: "Getting started.md" });
    expect(commits.length).toBe(1);
  });

  it("deletes the code and cannot be used again", async () => {
    const s = await start();
    expect(await exists(tokenPath(s))).toBe(true);
    expect((await post(s, account)).status).toBe(201);
    expect(await exists(tokenPath(s))).toBe(false);

    const again = await post(s, { username: "second", password: PASSWORD });
    expect(again.status).toBe(403);
    expect(await json(again)).toMatchObject({ code: "setup_complete" });
    expect(s.store.accounts.count()).toBe(1);
    expect(await json(await s.fetch("/api/setup/status"))).toMatchObject({ required: false });
    // Without a session the API now treats the caller as a guest, not as setup.
    expect(await json(await s.fetch("/api/auth/me"))).toEqual({ state: "guest" });
  });

  it("lets only one of several simultaneous requests win", async () => {
    const s = await start();
    const results = await Promise.all(
      ["a", "b", "c"].map((n) =>
        post(s, { username: `user-${n}`, password: PASSWORD, vault: { id: `v-${n}` } }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(s.store.accounts.count()).toBe(1);
    // The losers leave no vault behind.
    expect((await s.services.vaults.listVaults()).length).toBe(1);
  });

  it("validates the input before changing anything", async () => {
    const s = await start();
    expect((await post(s, { username: "x", password: PASSWORD })).status).toBe(400);
    expect((await post(s, { username: "root", password: "short" })).status).toBe(400);
    expect((await post(s, { ...account, vault: { id: "../escape" } })).status).toBe(400);
    expect(s.store.accounts.count()).toBe(0);
    expect(await s.services.vaults.listVaults()).toEqual([]);
    expect(await exists(tokenPath(s))).toBe(true);
    expect((await post(s, account)).status).toBe(201);
  });

  it("rejects a cross-site request", async () => {
    const s = await start();
    const res = await post(s, account, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(s.store.accounts.count()).toBe(0);
  });
});

describe("existing installs", () => {
  it("removes a leftover code when an account already exists", async () => {
    const s = await start();
    await post(s, account);
    const dataDir = s.dataDir;
    await s.close();
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(dataDir, "setup-token"), "X\n"),
    );
    server = await startTestServer({ devInsecure: false, dataDir });
    expect(await exists(path.join(dataDir, "setup-token"))).toBe(false);
  });
});

describe("--dev-insecure", () => {
  it("keeps the API open and writes no code", async () => {
    server = await startTestServer({ devInsecure: true });
    expect(await json(await server.fetch("/api/auth/me"))).toEqual({ state: "open" });
    expect((await server.fetch("/api/vaults")).status).toBe(200);
    expect(await exists(tokenPath(server))).toBe(false);
  });

  it("is refused unless the server listens on loopback", () => {
    expect(() => loadConfig({ PALIMVO_DEV_INSECURE: "1", PALIMVO_HOST: "0.0.0.0" })).toThrow(
      /loopback/,
    );
    expect(() => loadConfig({ PALIMVO_HOST: "192.168.1.5" }, { "dev-insecure": "true" })).toThrow(
      /loopback/,
    );
    expect(loadConfig({}, { "dev-insecure": "true" }).config.devInsecure).toBe(true);
    expect(loadConfig({ PALIMVO_DEV_INSECURE: "1", PALIMVO_HOST: "::1" }).config.devInsecure).toBe(
      true,
    );
    expect(defaultConfig().devInsecure).toBe(false);
    expect(loadConfig({ PALIMVO_HOST: "0.0.0.0" }).config.devInsecure).toBe(false);
  });
});

describe("isLoopbackHost / isLocalRequest", () => {
  it("recognises loopback names", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST"])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["0.0.0.0", "::", "10.0.0.2", "example.com", "127.0.0.1.evil.com"])
      expect(isLoopbackHost(h), h).toBe(false);
  });

  const headers = (h: Record<string, string>) => (name: string) => h[name];

  it("accepts only an untouched request to localhost from a loopback socket", () => {
    expect(isLocalRequest("127.0.0.1", headers({ host: "localhost:3000" }))).toBe(true);
    expect(isLocalRequest("::ffff:127.0.0.1", headers({ host: "127.0.0.1:3000" }))).toBe(true);
    expect(isLocalRequest("::1", headers({ host: "[::1]:3000" }))).toBe(true);
    // Not loopback.
    expect(isLocalRequest("192.168.1.9", headers({ host: "localhost" }))).toBe(false);
    expect(isLocalRequest(undefined, headers({ host: "localhost" }))).toBe(false);
    // A tunnel or proxy on this machine.
    expect(
      isLocalRequest("127.0.0.1", headers({ host: "localhost", "x-forwarded-for": "1.2.3.4" })),
    ).toBe(false);
    expect(isLocalRequest("127.0.0.1", headers({ host: "localhost", "cf-ray": "abc" }))).toBe(
      false,
    );
    // The public name (DNS rebinding or a proxy that rewrites nothing).
    expect(isLocalRequest("127.0.0.1", headers({ host: "notes.example.com" }))).toBe(false);
    expect(isLocalRequest("127.0.0.1", headers({}))).toBe(false);
  });
});
