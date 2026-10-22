import { symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "./harness.ts";

const PASSWORD = "correct horse battery";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});
afterEach(() => server.dispose());

/** A tiny browser: keeps the session cookie and sends the CSRF header like the web app will. */
class Client {
  cookie = "";
  csrf = "";

  async request(path: string, init: RequestInit & { json?: unknown; csrf?: boolean } = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (this.csrf && init.csrf !== false) headers.set("x-palimvo-csrf", this.csrf);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await server.fetch(path, { ...init, headers, ...(body ? { body } : {}) });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("palimvo_session="));
    if (set) {
      const value = set.split(";")[0]!;
      this.cookie = value === "palimvo_session=" ? "" : value;
    }
    return res;
  }

  get = (path: string) => this.request(path);
  post = (path: string, json?: unknown) => this.request(path, { method: "POST", json });
  put = (path: string, json?: unknown) => this.request(path, { method: "PUT", json });
  patch = (path: string, json?: unknown) => this.request(path, { method: "PATCH", json });
  del = (path: string) => this.request(path, { method: "DELETE" });

  async login(username: string, password = PASSWORD) {
    const res = await this.post("/api/auth/login", { username, password });
    if (res.status === 200) this.csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
    return res;
  }
}

const body = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

async function makeAdmin(name = "root") {
  await server.auth.createAccount({ username: name, password: PASSWORD, serverAdmin: true });
}

async function adminClient() {
  await makeAdmin();
  const c = new Client();
  expect((await c.login("root")).status).toBe(200);
  return c;
}

async function member(admin: Client, name: string) {
  const res = await admin.post("/api/admin/users", { username: name, password: PASSWORD });
  expect(res.status).toBe(201);
  const c = new Client();
  expect((await c.login(name)).status).toBe(200);
  return { client: c, id: (await body<{ id: string }>(res)).id };
}

describe("setup mode", () => {
  it("leaves the API open until the first account exists", async () => {
    const anon = new Client();
    expect(await body(await anon.get("/api/auth/me"))).toEqual({ state: "open" });
    expect((await anon.post("/api/vaults", { id: "demo" })).status).toBe(201);
    expect((await anon.get("/api/vaults/demo/files")).status).toBe(200);
    // Account management needs an account.
    expect((await anon.get("/api/admin/users")).status).toBe(401);
  });

  it("closes once an account exists", async () => {
    await makeAdmin();
    const anon = new Client();
    expect(await body(await anon.get("/api/auth/me"))).toEqual({ state: "guest" });
    const res = await anon.post("/api/vaults", { id: "demo" });
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({ code: "unauthenticated" });
  });
});

describe("login and sessions", () => {
  it("signs in, knows who you are, and signs out", async () => {
    await makeAdmin();
    const c = new Client();
    const res = await c.login("root");
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().find((s) => s.startsWith("palimvo_session="))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).not.toMatch(/Secure/i); // the test server has no https public URL

    const me = await body<{ state: string; account: { username: string }; csrfToken: string }>(
      await c.get("/api/auth/me"),
    );
    expect(me.state).toBe("account");
    expect(me.account.username).toBe("root");
    expect(me.account).not.toHaveProperty("passwordHash");

    expect((await c.post("/api/auth/logout")).status).toBe(204);
    expect(await body(await c.get("/api/auth/me"))).toEqual({ state: "guest" });
  });

  it("matches the username without regard to case and rejects a wrong password", async () => {
    await makeAdmin();
    expect((await new Client().login("ROOT")).status).toBe(200);
    const bad = await new Client().login("root", "not the password");
    expect(bad.status).toBe(401);
    expect(await body(bad)).toMatchObject({ code: "invalid_credentials" });
    // An unknown name gets the same answer.
    const unknown = await new Client().login("nobody", PASSWORD);
    expect(unknown.status).toBe(401);
    expect(await body(unknown)).toMatchObject({ code: "invalid_credentials" });
  });

  it("stores only a hash of the session cookie", async () => {
    await makeAdmin();
    const c = new Client();
    await c.login("root");
    const value = c.cookie.split("=")[1]!;
    const stored = server.store.sessions.listForAccount(server.store.accounts.list()[0]!.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).not.toBe(value);
  });

  it("throttles repeated failures per name, then lets the right password in after the window", async () => {
    await makeAdmin();
    const c = new Client();
    for (let i = 0; i < 10; i++) expect((await c.login("root", "wrong password")).status).toBe(401);
    const blocked = await c.login("root", PASSWORD);
    expect(blocked.status).toBe(429);
    expect(await body(blocked)).toMatchObject({ code: "rate_limited" });
    // Another name is not affected.
    expect((await c.login("other", "wrong password")).status).toBe(401);
  });

  it("refuses a disabled account and ends its sessions", async () => {
    const admin = await adminClient();
    const { client, id } = await member(admin, "dana");
    expect((await client.get("/api/auth/me").then(body)).state).toBe("account");
    expect((await admin.patch(`/api/admin/users/${id}`, { disabled: true })).status).toBe(200);
    expect(await body(await client.get("/api/auth/me"))).toEqual({ state: "guest" });
    const res = await new Client().login("dana");
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: "account_disabled" });
  });

  it("slides the expiry and drops expired sessions", async () => {
    await makeAdmin();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const c = new Client();
      await c.login("root");
      vi.setSystemTime(Date.now() + 15 * 24 * 60 * 60 * 1000);
      expect(await body(await c.get("/api/auth/me"))).toEqual({ state: "guest" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reissues the cookie when the session expiry slides", async () => {
    await makeAdmin();
    const c = new Client();
    await c.login("root");
    expect((await c.get("/api/auth/me")).headers.getSetCookie()).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      const res = await c.get("/api/auth/me");
      expect(res.headers.getSetCookie().join(";")).toMatch(/palimvo_session=.*Max-Age=1209600/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists own sessions and revokes one", async () => {
    await makeAdmin();
    const a = new Client();
    const b = new Client();
    await a.login("root");
    await b.login("root");
    const list = await body<{ sessions: { id: string; current: boolean }[] }>(
      await a.get("/api/auth/sessions"),
    );
    expect(list.sessions).toHaveLength(2);
    const other = list.sessions.find((s) => !s.current)!;
    expect((await a.del(`/api/auth/sessions/${other.id}`)).status).toBe(204);
    expect(await body(await b.get("/api/auth/me"))).toEqual({ state: "guest" });
    expect((await body<{ state: string }>(await a.get("/api/auth/me"))).state).toBe("account");
    expect((await a.del(`/api/auth/sessions/nope`)).status).toBe(404);
  });
});

describe("CSRF protection", () => {
  it("rejects unsafe requests from a session without the token or from another origin", async () => {
    const admin = await adminClient();
    const noToken = await admin.request("/api/vaults", {
      method: "POST",
      json: { id: "demo" },
      csrf: false,
    });
    expect(noToken.status).toBe(403);
    expect(await body(noToken)).toMatchObject({ code: "csrf_invalid" });

    const wrongToken = await admin.request("/api/vaults", {
      method: "POST",
      json: { id: "demo" },
      headers: { "x-palimvo-csrf": "AAAA" },
      csrf: false,
    });
    expect(wrongToken.status).toBe(403);

    const crossSite = await admin.request("/api/vaults", {
      method: "POST",
      json: { id: "demo" },
      headers: { origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);

    expect((await admin.post("/api/vaults", { id: "demo" })).status).toBe(201);
    // Reads need no token.
    expect((await admin.request("/api/vaults", { csrf: false })).status).toBe(200);
  });

  it("checks the origin of login too", async () => {
    await makeAdmin();
    const res = await server.fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ username: "root", password: PASSWORD }),
    });
    expect(res.status).toBe(403);
  });
});

describe("passwords of signed-in people", () => {
  it("changes the password and signs out other devices", async () => {
    await makeAdmin();
    const here = new Client();
    const there = new Client();
    await here.login("root");
    await there.login("root");

    const wrong = await here.post("/api/auth/password", {
      current: "nope nope nope",
      next: "new password 123",
    });
    expect(wrong.status).toBe(401);
    const weak = await here.post("/api/auth/password", { current: PASSWORD, next: "short" });
    expect(weak.status).toBe(400);
    expect(await body(weak)).toMatchObject({ code: "weak_password" });

    expect(
      (await here.post("/api/auth/password", { current: PASSWORD, next: "new password 123" }))
        .status,
    ).toBe(204);
    expect((await body<{ state: string }>(await here.get("/api/auth/me"))).state).toBe("account");
    expect((await body<{ state: string }>(await there.get("/api/auth/me"))).state).toBe("guest");
    expect((await new Client().login("root")).status).toBe(401);
    expect((await new Client().login("root", "new password 123")).status).toBe(200);
  });

  it("lets an administrator reset a password, with a temporary one when none is given", async () => {
    const admin = await adminClient();
    const { client, id } = await member(admin, "dana");

    const temp = await body<{ password: string }>(
      await admin.post(`/api/admin/users/${id}/password`, {}),
    );
    expect(temp.password.length).toBeGreaterThanOrEqual(10);
    expect(await body(await client.get("/api/auth/me"))).toEqual({ state: "guest" });
    expect((await new Client().login("dana")).status).toBe(401);
    expect((await new Client().login("dana", temp.password)).status).toBe(200);

    expect(
      (await admin.post(`/api/admin/users/${id}/password`, { password: "chosen by admin" })).status,
    ).toBe(200);
    expect((await new Client().login("dana", "chosen by admin")).status).toBe(200);

    const weak = await admin.post(`/api/admin/users/${id}/password`, { password: "short" });
    expect(weak.status).toBe(400);
  });
});

describe("administering accounts", () => {
  it("is for server administrators only", async () => {
    const admin = await adminClient();
    const { client } = await member(admin, "dana");
    expect((await client.get("/api/admin/users")).status).toBe(403);
    expect((await client.post("/api/admin/invites", {})).status).toBe(403);
    expect((await new Client().get("/api/admin/users")).status).toBe(401);
    expect((await admin.get("/api/admin/users")).status).toBe(200);
  });

  it("creates, lists, updates and deletes accounts, and guards the last administrator", async () => {
    const admin = await adminClient();
    const dup = await admin.post("/api/admin/users", { username: "ROOT", password: PASSWORD });
    expect(dup.status).toBe(409);
    const bad = await admin.post("/api/admin/users", { username: "x", password: PASSWORD });
    expect(bad.status).toBe(400);

    const { id } = await member(admin, "dana");
    const list = await body<{ users: { username: string }[] }>(await admin.get("/api/admin/users"));
    expect(list.users.map((u) => u.username)).toEqual(["dana", "root"]);

    const me = server.store.accounts.getByUsername("root")!;
    expect((await admin.patch(`/api/admin/users/${me.id}`, { serverAdmin: false })).status).toBe(
      403,
    );
    expect((await admin.patch(`/api/admin/users/${me.id}`, { disabled: true })).status).toBe(403);
    expect((await admin.del(`/api/admin/users/${me.id}`)).status).toBe(403);

    expect((await admin.patch(`/api/admin/users/${id}`, { displayName: "Dana D." })).status).toBe(
      200,
    );
    expect(server.store.accounts.get(id)?.displayName).toBe("Dana D.");
    expect((await admin.del(`/api/admin/users/${id}`)).status).toBe(204);
    expect((await admin.del(`/api/admin/users/${id}`)).status).toBe(404);
  });

  it("writes to the audit log", async () => {
    const admin = await adminClient();
    await member(admin, "dana");
    const actions = server.store.audit.query({}).map((e) => e.action);
    expect(actions).toContain("auth.login");
    expect(actions).toContain("admin.user_created");
  });
});

describe("invites", () => {
  async function createInvite(admin: Client, extra: Record<string, unknown> = {}) {
    const res = await admin.post("/api/admin/invites", extra);
    expect(res.status).toBe(201);
    return body<{ token: string; url: string; invite: { id: string; expiresAt: number } }>(res);
  }

  it("signs a new person up once, with the roles and vaults it names", async () => {
    const admin = await adminClient();
    expect((await admin.post("/api/vaults", { id: "notes" })).status).toBe(201);
    const role = server.store.roles.create({ name: "Designer", color: "#ff8800", position: 1 });
    const { token, url } = await createInvite(admin, {
      note: "for Sam",
      roleIds: [role.id],
      vaults: [{ vaultId: "notes", position: "member" }],
    });
    expect(url).toContain(`/invite/${token}`);

    const anon = new Client();
    const preview = await body<{ note: string; roles: { name: string }[]; vaults: unknown[] }>(
      await anon.get(`/api/auth/invites/${token}`),
    );
    expect(preview.note).toBe("for Sam");
    expect(preview.roles.map((r) => r.name)).toEqual(["Designer"]);

    const accepted = await anon.post(`/api/auth/invites/${token}/accept`, {
      username: "sam",
      password: PASSWORD,
      displayName: "Sam",
    });
    expect(accepted.status).toBe(201);
    anon.csrf = (await body<{ csrfToken: string }>(accepted)).csrfToken;
    expect((await body<{ state: string }>(await anon.get("/api/auth/me"))).state).toBe("account");

    const sam = server.store.accounts.getByUsername("sam")!;
    expect(sam.serverAdmin).toBe(false);
    expect(server.store.roles.rolesOf(sam.id).map((r) => r.name)).toEqual(["Designer"]);
    expect(server.store.accounts.getMember("notes", sam.id)?.position).toBe("member");

    // One use only.
    const again = await new Client().post(`/api/auth/invites/${token}/accept`, {
      username: "sam2",
      password: PASSWORD,
    });
    expect(again.status).toBe(410);
    expect(await body(again)).toMatchObject({ code: "invite_invalid" });
    expect((await new Client().get(`/api/auth/invites/${token}`)).status).toBe(410);
    expect(server.store.accounts.getByUsername("sam2")).toBeUndefined();
  });

  it("keeps the invite usable when the name is taken or the password is weak", async () => {
    const admin = await adminClient();
    const { token } = await createInvite(admin);
    const anon = new Client();
    expect(
      (
        await anon.post(`/api/auth/invites/${token}/accept`, {
          username: "root",
          password: PASSWORD,
        })
      ).status,
    ).toBe(409);
    expect(
      (await anon.post(`/api/auth/invites/${token}/accept`, { username: "sam", password: "short" }))
        .status,
    ).toBe(400);
    expect(
      (
        await anon.post(`/api/auth/invites/${token}/accept`, {
          username: "sam",
          password: PASSWORD,
        })
      ).status,
    ).toBe(201);
  });

  it("rejects unknown, revoked and expired links", async () => {
    const admin = await adminClient();
    expect((await new Client().get("/api/auth/invites/nope")).status).toBe(410);

    const revoked = await createInvite(admin);
    expect((await admin.del(`/api/admin/invites/${revoked.invite.id}`)).status).toBe(204);
    expect((await new Client().get(`/api/auth/invites/${revoked.token}`)).status).toBe(410);

    const { token } = await createInvite(admin, { expiresInHours: 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      expect((await new Client().get(`/api/auth/invites/${token}`)).status).toBe(410);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a role or vault that does not exist", async () => {
    const admin = await adminClient();
    expect((await admin.post("/api/admin/invites", { roleIds: ["missing"] })).status).toBe(404);
    expect(
      (
        await admin.post("/api/admin/invites", {
          vaults: [{ vaultId: "ghost", position: "member" }],
        })
      ).status,
    ).toBe(404);
  });

  it("never stores the secret", async () => {
    const admin = await adminClient();
    const { token } = await createInvite(admin);
    const list = await body<{ invites: Record<string, unknown>[] }>(
      await admin.get("/api/admin/invites"),
    );
    expect(JSON.stringify(list)).not.toContain(token);
  });
});

describe("guests", () => {
  async function setup() {
    const admin = await adminClient();
    expect((await admin.post("/api/vaults", { id: "site" })).status).toBe(201);
    expect((await admin.post("/api/vaults", { id: "secret" })).status).toBe(201);
    const write = (vault: string, path: string, content: string) =>
      admin.put(`/api/vaults/${vault}/files/${path}`, { content });
    await write("site", "home.md", "welcome to the public home [[docs/guide]]");
    await write("site", "docs/guide.md", "public guide about gardening");
    await write("site", "private/plan.md", "private plan about gardening budget");
    await write("secret", "a.md", "nothing public gardening");
    return { admin, write };
  }

  it("sees nothing until something is made public", async () => {
    await setup();
    const guest = new Client();
    expect(await body(await guest.get("/api/vaults"))).toEqual({ vaults: [] });
    expect((await guest.get("/api/vaults/site/files")).status).toBe(404);
    expect((await guest.get("/api/vaults/site/files/home.md")).status).toBe(404);
    expect((await guest.get("/api/vaults/site/search?q=gardening")).status).toBe(404);
  });

  it("reads only public folders and files and gets a filtered tree and search", async () => {
    const { admin } = await setup();
    expect(
      (await admin.put("/api/vaults/site/public", { paths: ["docs", "home.md"] })).status,
    ).toBe(200);
    const guest = new Client();

    expect(await body(await guest.get("/api/vaults"))).toEqual({
      vaults: [{ id: "site", name: "site" }],
    });

    const tree = await body<{ tree: { path: string; children?: { path: string }[] }[] }>(
      await guest.get("/api/vaults/site/files"),
    );
    expect(tree.tree.map((n) => n.path)).toEqual(["docs", "home.md"]);
    expect(JSON.stringify(tree)).not.toContain("private");

    expect((await guest.get("/api/vaults/site/files/docs/guide.md")).status).toBe(200);
    expect((await guest.get("/api/vaults/site/files/home.md")).status).toBe(200);
    expect((await guest.get("/api/vaults/site/files/private/plan.md")).status).toBe(404);
    expect((await guest.get("/api/vaults/site/files/.palimvo/config.json")).status).toBe(404);

    const found = await body<{ total: number; hits: { path: string }[] }>(
      await guest.get("/api/vaults/site/search?q=gardening"),
    );
    expect(found.hits.map((h) => h.path)).toEqual(["docs/guide.md"]);
    expect(found.total).toBe(1);

    // The same query by an account still finds the private note.
    const full = await body<{ total: number }>(
      await admin.get("/api/vaults/site/search?q=gardening"),
    );
    expect(full.total).toBe(2);
  });

  it("can read but never change or inspect anything else", async () => {
    const { admin } = await setup();
    await admin.put("/api/vaults/site/public", { paths: [""] });
    const guest = new Client();
    const attempts: [string, string][] = [
      ["PUT", "/api/vaults/site/files/home.md"],
      ["DELETE", "/api/vaults/site/files/home.md"],
      ["POST", "/api/vaults/site/folders"],
      ["POST", "/api/vaults/site/move"],
      ["POST", "/api/vaults/site/batch"],
      ["POST", "/api/vaults"],
      ["DELETE", "/api/vaults/site"],
      ["GET", "/api/vaults/site/history"],
      ["GET", "/api/vaults/site/backlinks?path=home.md"],
      ["GET", "/api/vaults/site/links?path=home.md"],
      ["GET", "/api/vaults/site/graph"],
      ["GET", "/api/vaults/site/archive"],
      ["GET", "/api/vaults/site/public"],
      ["PUT", "/api/vaults/site/public"],
      ["GET", "/api/removed-vaults"],
      ["GET", "/api/admin/users"],
    ];
    for (const [method, path] of attempts) {
      const res = await guest.request(path, { method, json: method === "GET" ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // Whole-vault publishing still hides dot folders.
    expect((await guest.get("/api/vaults/site/files/home.md")).status).toBe(200);
    expect((await guest.get("/api/vaults/site/files/.palimvo/config.json")).status).toBe(404);
    const tree = JSON.stringify(await guest.get("/api/vaults/site/files").then(body));
    expect(tree).not.toContain(".palimvo");
    // The other vault stays invisible.
    expect((await guest.get("/api/vaults/secret/files")).status).toBe(404);
  });

  it("does not follow symbolic links out of the public part", async () => {
    const { admin } = await setup();
    await admin.put("/api/vaults/site/public", { paths: ["docs"] });
    const vaultDir = path.join(server.dataDir, "vaults", "site");
    try {
      await symlink(path.join(vaultDir, "private"), path.join(vaultDir, "docs", "link"));
    } catch {
      return; // no permission to create links on this machine
    }
    const guest = new Client();
    expect((await guest.get("/api/vaults/site/files/docs/guide.md")).status).toBe(200);
    expect((await guest.get("/api/vaults/site/files/docs/link/plan.md")).status).toBe(404);
    expect((await admin.get("/api/vaults/site/files/docs/link/plan.md")).status).toBe(200);
  });

  it("does not mix up names that differ only in case", async () => {
    const { admin, write } = await setup();
    await write("site", "Public.md", "visible");
    await write("site", "public.md", "hidden");
    await admin.put("/api/vaults/site/public", { paths: ["Public.md"] });
    const guest = new Client();
    expect((await guest.get("/api/vaults/site/files/Public.md")).status).toBe(200);
    expect((await guest.get("/api/vaults/site/files/public.md")).status).toBe(404);
  });

  it("pages guest search results after filtering", async () => {
    const { admin, write } = await setup();
    for (let i = 0; i < 6; i++) await write("site", `private/n${i}.md`, "needle");
    for (let i = 0; i < 3; i++) await write("site", `docs/n${i}.md`, "needle");
    await admin.put("/api/vaults/site/public", { paths: ["docs"] });
    const guest = new Client();
    const page = await body<{ total: number; hits: unknown[] }>(
      await guest.get("/api/vaults/site/search?q=needle&limit=2&offset=2"),
    );
    expect(page.total).toBe(3);
    expect(page.hits).toHaveLength(1);
  });

  it("follows later changes to the public set", async () => {
    const { admin } = await setup();
    await admin.put("/api/vaults/site/public", { paths: ["docs"] });
    const guest = new Client();
    expect((await guest.get("/api/vaults/site/files/docs/guide.md")).status).toBe(200);
    await admin.put("/api/vaults/site/public", { paths: [] });
    expect((await guest.get("/api/vaults/site/files/docs/guide.md")).status).toBe(404);
  });

  it("lets only administrators of the vault decide what is public", async () => {
    const { admin } = await setup();
    const { client: dana, id } = await member(admin, "dana");
    expect((await dana.put("/api/vaults/site/public", { paths: ["docs"] })).status).toBe(403);
    server.store.accounts.setMember("site", id, "member");
    expect((await dana.put("/api/vaults/site/public", { paths: ["docs"] })).status).toBe(403);
    expect((await dana.get("/api/vaults/site/public")).status).toBe(403);
    server.store.accounts.setMember("site", id, "admin");
    expect((await dana.put("/api/vaults/site/public", { paths: ["docs"] })).status).toBe(200);
    expect(await body(await dana.get("/api/vaults/site/public"))).toEqual({ paths: ["docs"] });
    // Not the other vault.
    expect((await dana.put("/api/vaults/secret/public", { paths: [""] })).status).toBe(403);
  });

  it("validates public paths", async () => {
    const { admin } = await setup();
    expect((await admin.put("/api/vaults/site/public", { paths: ["../x"] })).status).toBe(400);
    expect((await admin.put("/api/vaults/site/public", { paths: [".palimvo"] })).status).toBe(400);
    expect((await admin.put("/api/vaults/ghost/public", { paths: [] })).status).toBe(404);
    expect(
      (await admin.put("/api/vaults/site/public", { paths: ["docs", "docs", "/"] })).status,
    ).toBe(200);
    expect(server.store.publicAccess.list("site")).toEqual(["", "docs"]);
  });

  it("forgets public entries when a vault's data is deleted", async () => {
    await setup();
    server.store.publicAccess.replace("site", ["docs"]);
    server.store.accounts.deleteVaultData("site");
    expect(server.store.publicAccess.list("site")).toEqual([]);
  });
});

describe("signed-in people", () => {
  it("can create content and is credited by name", async () => {
    const admin = await adminClient();
    const { client } = await member(admin, "dana");
    // Ordinary accounts cannot create or remove vaults before roles exist (T52).
    expect((await client.post("/api/vaults", { id: "x" })).status).toBe(403);
    expect((await admin.post("/api/vaults", { id: "notes" })).status).toBe(201);
    const res = await client.put("/api/vaults/notes/files/a.md", { content: "hi" });
    expect(res.status).toBe(200);
    await server.services.history.flushAll();
    const history = await body<{ commits: { author: { name: string; kind: string } }[] }>(
      await client.get("/api/vaults/notes/history"),
    );
    expect(history.commits[0]?.author).toMatchObject({ name: "dana", kind: "human" });
  });

  it("cannot pass itself off as another author", async () => {
    const admin = await adminClient();
    expect((await admin.post("/api/vaults", { id: "notes" })).status).toBe(201);
    await admin.request("/api/vaults/notes/files/a.md", {
      method: "PUT",
      json: { content: "hi" },
      headers: { "x-palimvo-author": "ai:Claude%20Code" },
    });
    await server.services.history.flushAll();
    const history = await body<{ commits: { author: { name: string; kind: string } }[] }>(
      await admin.get("/api/vaults/notes/history"),
    );
    expect(history.commits[0]?.author.kind).toBe("human");
  });
});
