import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskOf, type PermissionName } from "@palimvo/core";
import { accessOf } from "../src/auth/access.ts";
import { bearerMiddleware } from "../src/auth/bearer.ts";
import { sha256Hex } from "../src/auth/tokens.ts";
import { errorHandler } from "../src/errors.ts";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer({ publicUrl: "https://palimvo.test" });
});
afterEach(() => server.dispose());

const store = () => server.store;

async function signIn(name: string, serverAdmin = false) {
  const account = await server.auth.createAccount({
    username: name,
    password: PASSWORD,
    serverAdmin,
  });
  const client = new Client(server);
  expect((await client.login(name)).status).toBe(200);
  return { client, id: account.id };
}

const deny = (vaultId: string, accountId: string, names: PermissionName[], folder?: string) =>
  store().roles.setOverride(
    {
      scope: folder === undefined ? "vault" : "folder",
      vaultId,
      ...(folder === undefined ? {} : { folder }),
      subjectType: "account",
      subjectId: accountId,
    },
    { allow: 0, deny: maskOf(names) },
  );

/** What an MCP tool would do: ask the request's access helper for a permission. */
function probeApp() {
  const app = new Hono();
  app.onError(errorHandler(server.logger));
  app.use(
    "/probe/*",
    bearerMiddleware({
      auth: server.auth,
      tokens: server.auth.tokens,
      publicUrl: "https://palimvo.test",
    }),
  );
  app.get("/probe/:vault/read", (c) => {
    accessOf(c).requireVault("note.read", c.req.param("vault"));
    return c.json({ ok: true });
  });
  app.put("/probe/:vault/write/*", (c) => {
    const path = c.req.path.split("/write/")[1] ?? "";
    accessOf(c).requireTree("note.write", c.req.param("vault"), path);
    return c.json({ ok: true });
  });
  app.get("/probe/admin", (c) => {
    accessOf(c).requireServer("server.manage");
    return c.json({ ok: true });
  });
  app.get("/probe/:vault/settings", (c) => {
    accessOf(c).requireVault("vault.settings", c.req.param("vault"));
    return c.json({ ok: true });
  });
  return (
    path: string,
    secret: string | undefined,
    method = "GET",
    extra: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...extra },
    });
}

async function makeToken(
  who: { client: Client },
  body: Record<string, unknown>,
): Promise<{ secret: string; id: string }> {
  const res = await who.client.post("/api/tokens", body);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  const out = await json<{ secret: string; token: { id: string } }>(res);
  return { secret: out.secret, id: out.token.id };
}

async function world() {
  const root = await signIn("root", true);
  for (const v of ["a", "b"]) {
    expect((await root.client.post("/api/vaults", { id: v })).status).toBe(201);
  }
  const mia = await signIn("mia");
  store().joinVault("a", mia.id, "member");
  store().joinVault("b", mia.id, "member");
  return { root, mia };
}

describe("creating tokens", () => {
  it("shows the secret once and keeps only a hash", async () => {
    const { mia } = await world();
    const res = await mia.client.post("/api/tokens", { name: "Claude Code", access: "write" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { secret, token } = await json<{ secret: string; token: Record<string, unknown> }>(res);
    expect(secret).toMatch(/^plm_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(token)).not.toContain(secret);
    const row = store().tokens.getActiveByHash(sha256Hex(secret));
    expect(row?.name).toBe("Claude Code");
    const list = await json<{ tokens: Record<string, unknown>[] }>(
      await mia.client.get("/api/tokens"),
    );
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(list.tokens[0]).toMatchObject({ name: "Claude Code", access: "write", active: true });
    // 90 days by default.
    expect(token.expiresAt as number).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    const audit = store().audit.query({ action: "token.created" });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("can be made without an expiry, and validates its input", async () => {
    const { mia } = await world();
    const forever = await json<{ token: { expiresAt: number | null } }>(
      await mia.client.post("/api/tokens", { name: "x", access: "read", expiresInDays: null }),
    );
    expect(forever.token.expiresAt).toBeNull();
    for (const bad of [
      { name: "", access: "read" },
      { name: "x", access: "admin" },
      { name: "x", access: "read", expiresInDays: 0 },
      { name: "x", access: "read", rateLimitPerMinute: 999_999 },
      { name: "x", access: "read", folders: ["docs"] },
      { name: "x", access: "read", vaultId: "a", folders: ["../etc"] },
    ])
      expect((await mia.client.post("/api/tokens", bad)).status, JSON.stringify(bad)).toBe(400);
    expect(
      (await mia.client.post("/api/tokens", { name: "x", access: "read", vaultId: "nope" })).status,
    ).toBe(404);
  });

  it("needs mcp.connect and never hands out more than its maker holds", async () => {
    const { mia } = await world();
    deny("a", mia.id, ["note.write"]);
    // Reader in a: cannot make a write token for a, but can make a read one.
    expect(
      (await mia.client.post("/api/tokens", { name: "w", access: "write", vaultId: "a" })).status,
    ).toBe(403);
    expect(
      (await mia.client.post("/api/tokens", { name: "r", access: "read", vaultId: "a" })).status,
    ).toBe(201);
    deny("a", mia.id, ["mcp.connect"]);
    expect(
      (await mia.client.post("/api/tokens", { name: "r", access: "read", vaultId: "a" })).status,
    ).toBe(403);
    // All-vault tokens still work: b has mcp.connect.
    expect((await mia.client.post("/api/tokens", { name: "all", access: "read" })).status).toBe(
      201,
    );
    deny("b", mia.id, ["mcp.connect"]);
    expect((await mia.client.post("/api/tokens", { name: "all", access: "read" })).status).toBe(
      403,
    );
  });

  it("is only possible for a signed-in person, never with a token", async () => {
    const { mia } = await world();
    const { secret } = await makeToken(mia, { name: "t", access: "write" });
    const res = await server.fetch("/api/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "child", access: "read" }),
    });
    expect(res.status).toBe(401);
  });

  it("lets owners revoke their own tokens, administrators anyone's, and nobody else's", async () => {
    const { root, mia } = await world();
    const other = await signIn("omar");
    const t = await makeToken(mia, { name: "t", access: "read" });
    expect((await other.client.del(`/api/tokens/${t.id}`)).status).toBe(404);
    expect((await other.client.get("/api/admin/tokens")).status).toBe(403);
    const all = await json<{ tokens: { id: string; owner: string }[] }>(
      await root.client.get("/api/admin/tokens"),
    );
    expect(all.tokens.find((x) => x.id === t.id)?.owner).toBe("mia");
    expect((await root.client.del(`/api/admin/tokens/${t.id}`)).status).toBe(204);
    expect(store().tokens.get(t.id)?.revokedAt).toBeDefined();
    expect(store().audit.query({ action: "token.revoked" })).toHaveLength(1);
    const own = await makeToken(mia, { name: "u", access: "read" });
    expect((await mia.client.del(`/api/tokens/${own.id}`)).status).toBe(204);
  });
});

describe("using tokens", () => {
  it("answers 401 with the OAuth discovery challenge, and ignores browser sessions", async () => {
    const { mia } = await world();
    const call = probeApp();
    const none = await call("/probe/a/read", undefined);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      'Bearer realm="palimvo", resource_metadata="https://palimvo.test/.well-known/oauth-protected-resource"',
    );
    const bad = await call("/probe/a/read", "plm_wrong");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const cookie = await call("/probe/a/read", undefined, "GET", { cookie: mia.client.cookie });
    expect(cookie.status).toBe(401);
    const real = await server.fetch("/mcp", { headers: { cookie: mia.client.cookie } });
    expect(real.status).toBe(401);
  });

  it("limits a token to its access level", async () => {
    const { mia } = await world();
    const call = probeApp();
    const read = await makeToken(mia, { name: "r", access: "read" });
    const write = await makeToken(mia, { name: "w", access: "write" });
    const propose = await makeToken(mia, { name: "p", access: "propose" });
    for (const t of [read, write, propose])
      expect((await call("/probe/a/read", t.secret)).status).toBe(200);
    const denied = await call("/probe/a/write/x.md", read.secret, "PUT");
    expect(denied.status).toBe(403);
    expect((await json<{ code: string }>(denied)).code).toBe("token_scope_denied");
    const proposed = await call("/probe/a/write/x.md", propose.secret, "PUT");
    expect(proposed.status).toBe(403);
    expect((await json<{ code: string }>(proposed)).code).toBe("propose_only");
    expect((await call("/probe/a/write/x.md", write.secret, "PUT")).status).toBe(200);
  });

  it("limits a token to its vault and folders", async () => {
    const { mia } = await world();
    const call = probeApp();
    const t = await makeToken(mia, {
      name: "scoped",
      access: "write",
      vaultId: "a",
      folders: ["open"],
    });
    expect((await call("/probe/a/read", t.secret)).status).toBe(200);
    expect((await call("/probe/a/write/open/n.md", t.secret, "PUT")).status).toBe(200);
    const outside = await call("/probe/a/write/locked/n.md", t.secret, "PUT");
    expect((await json<{ code: string }>(outside)).code).toBe("token_scope_denied");
    const otherVault = await call("/probe/b/read", t.secret);
    expect((await json<{ code: string }>(otherVault)).code).toBe("token_scope_denied");
  });

  it("never carries administration, even for a server administrator", async () => {
    const { root } = await world();
    const call = probeApp();
    const t = await makeToken(root, { name: "admin's", access: "write" });
    expect((await call("/probe/a/write/x.md", t.secret, "PUT")).status).toBe(200);
    expect((await call("/probe/admin", t.secret)).status).toBe(403);
    expect((await call("/probe/a/settings", t.secret)).status).toBe(403);
  });

  it("shrinks at once when its maker is demoted, and stops when they leave", async () => {
    const { mia } = await world();
    const call = probeApp();
    const t = await makeToken(mia, { name: "w", access: "write" });
    expect((await call("/probe/a/write/x.md", t.secret, "PUT")).status).toBe(200);
    deny("a", mia.id, ["note.write"]);
    const demoted = await call("/probe/a/write/x.md", t.secret, "PUT");
    expect(demoted.status).toBe(403);
    expect((await json<{ code: string }>(demoted)).code).toBe("forbidden");
    expect((await call("/probe/a/read", t.secret)).status).toBe(200);
    // Folder level too: only locked/ is taken away in b.
    deny("b", mia.id, ["note.write"], "locked");
    expect((await call("/probe/b/write/open/x.md", t.secret, "PUT")).status).toBe(200);
    expect((await call("/probe/b/write/locked/x.md", t.secret, "PUT")).status).toBe(403);
    // Without the right to connect AI the token is useless everywhere in that vault.
    deny("b", mia.id, ["mcp.connect"]);
    expect((await call("/probe/b/read", t.secret)).status).toBe(403);
    // Leaving the vault: it no longer exists for the token.
    store().accounts.removeMember("a", mia.id);
    const gone = await call("/probe/a/read", t.secret);
    expect(gone.status).toBe(404);
  });

  it("stops working when revoked, expired, or its owner is disabled", async () => {
    const { mia } = await world();
    const call = probeApp();
    const revoked = await makeToken(mia, { name: "r", access: "read" });
    const owner = await makeToken(mia, { name: "o", access: "read" });
    const secret = "plm_expired-token-for-the-test";
    store().tokens.create({
      accountId: mia.id,
      name: "old",
      tokenHash: sha256Hex(secret),
      access: "read",
      expiresAt: Date.now() - 1000,
    });
    expect((await call("/probe/a/read", revoked.secret)).status).toBe(200);
    expect((await mia.client.del(`/api/tokens/${revoked.id}`)).status).toBe(204);
    expect((await call("/probe/a/read", revoked.secret)).status).toBe(401);
    expect((await call("/probe/a/read", secret)).status).toBe(401);
    expect((await call("/probe/a/read", owner.secret)).status).toBe(200);
    store().accounts.update(mia.id, { disabled: true });
    expect((await call("/probe/a/read", owner.secret)).status).toBe(401);
  });

  it("limits calls per minute per token", async () => {
    const { mia } = await world();
    const call = probeApp();
    const t = await makeToken(mia, { name: "slow", access: "read", rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await call("/probe/a/read", t.secret)).status).toBe(200);
    const limited = await call("/probe/a/read", t.secret);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another token is not affected.
    const other = await makeToken(mia, { name: "other", access: "read" });
    expect((await call("/probe/a/read", other.secret)).status).toBe(200);
  });

  it("credits AI tokens as AI in the history", async () => {
    const { mia } = await world();
    const { requestAuthor } = await import("../src/routes/author.ts");
    const app = new Hono();
    app.use(
      "/who",
      bearerMiddleware({ auth: server.auth, tokens: server.auth.tokens, publicUrl: undefined }),
    );
    app.get("/who", (c) => c.json(requestAuthor(c)));
    const t = await makeToken(mia, { name: "Cursor", access: "write" });
    const res = await app.request("/who", { headers: { authorization: `Bearer ${t.secret}` } });
    expect(await res.json()).toMatchObject({ kind: "ai", name: "Cursor" });
    const named = await app.request("/who", {
      headers: { authorization: `Bearer ${t.secret}`, "x-palimvo-author": "ai%3AClaude%20Code" },
    });
    expect(await named.json()).toMatchObject({ kind: "ai", name: "Claude Code" });
  });
});
