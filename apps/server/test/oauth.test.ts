import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const BASE = "https://palimvo.test";
const REDIRECT = "https://claude.example/callback";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer({ publicUrl: BASE });
});
afterEach(() => server.dispose());

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function register(extra: Record<string, unknown> = {}) {
  const res = await server.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], ...extra }),
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return json<{ client_id: string; client_secret?: string }>(res);
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "mcp:write",
    resource: `${BASE}/mcp`,
    ...extra,
  });
}

/** Root makes vault `a`; mia joins it. */
async function world() {
  const root = await server.auth.createAccount({
    username: "root",
    password: PASSWORD,
    serverAdmin: true,
  });
  const rootClient = new Client(server);
  await rootClient.login("root");
  expect((await rootClient.post("/api/vaults", { id: "a" })).status).toBe(201);
  const mia = await server.auth.createAccount({ username: "mia", password: PASSWORD });
  server.store.joinVault("a", mia.id, "member");
  const browser = new Client(server);
  return { root, rootClient, mia, browser };
}

/** Walks a browser through sign-in and consent; returns the redirect the app receives. */
async function authorizeAs(
  browser: Client,
  clientId: string,
  challenge: string,
  opts: { access?: string; decision?: string; user?: string } = {},
) {
  const q = authorizeQuery(clientId, challenge);
  const first = await browser.request(`/oauth/authorize?${q}`);
  expect(first.status).toBe(200);
  expect(await first.text()).toContain('action="/oauth/login"');
  const fields = Object.fromEntries(q);
  const login = await browser.request("/oauth/login", {
    ...form({ ...fields, username: opts.user ?? "mia", password: PASSWORD }),
    redirect: "manual",
  });
  expect(login.status).toBe(303);
  const next = login.headers.get("location")!;
  expect(next.startsWith("/oauth/authorize?")).toBe(true);
  const consent = await browser.request(next);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const res = await browser.request("/oauth/authorize", {
    ...form({
      ...fields,
      csrf,
      decision: opts.decision ?? "allow",
      access: opts.access ?? "write",
    }),
    redirect: "manual",
  });
  return { res, csrf, fields };
}

const tokenRequest = (fields: Record<string, string>) => server.fetch("/oauth/token", form(fields));

describe("behind a path prefix", () => {
  it("posts and redirects under the configured path", async () => {
    const prefixed = await startTestServer({ publicUrl: "https://example.com/palimvo" });
    try {
      await prefixed.auth.createAccount({ username: "mia", password: PASSWORD });
      const reg = await prefixed.fetch("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      });
      const { client_id } = await json<{ client_id: string }>(reg);
      const q = authorizeQuery(client_id, pkce().challenge, {
        resource: "https://example.com/palimvo/mcp",
      });
      const page = await (await prefixed.fetch(`/oauth/authorize?${q}`)).text();
      expect(page).toContain('action="/palimvo/oauth/login"');
      const login = await prefixed.fetch("/oauth/login", {
        ...form({ ...Object.fromEntries(q), username: "mia", password: PASSWORD }),
        redirect: "manual",
      });
      expect(login.headers.get("location")).toMatch(/^\/palimvo\/oauth\/authorize\?/);
    } finally {
      await prefixed.dispose();
    }
  });
});

describe("without a public address", () => {
  it("explains what to set", async () => {
    const bare = await startTestServer();
    try {
      for (const path of [
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
      ]) {
        const res = await bare.fetch(path);
        expect(res.status).toBe(503);
        expect(await json(res)).toMatchObject({ code: "public_url_required" });
      }
      const page = await bare.fetch("/oauth/authorize?client_id=x");
      expect(page.status).toBe(503);
      expect(await page.text()).toContain("PALIMVO_PUBLIC_URL");
      const reg = await bare.fetch("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(reg.status).toBe(503);
    } finally {
      await bare.dispose();
    }
  });
});

describe("discovery and registration", () => {
  it("publishes the protected-resource and authorization-server documents", async () => {
    const res = await server.fetch("/.well-known/oauth-protected-resource/mcp");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
    });
    const meta = await json<Record<string, unknown>>(
      await server.fetch("/.well-known/oauth-authorization-server"),
    );
    expect(meta).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("registers clients and refuses unsafe return addresses", async () => {
    const client = await register();
    expect(client.client_id).toBeTruthy();
    expect(client.client_secret).toBeUndefined();
    for (const uri of [
      "http://evil.example/cb",
      "javascript:alert(1)",
      "https://x.example/cb#frag",
      "not a url",
    ]) {
      const res = await server.fetch("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      expect(res.status, uri).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
    // Desktop tools listen on loopback, and apps may use their own scheme.
    await register({
      redirect_uris: ["http://127.0.0.1:8123/cb", "http://localhost/cb", "cursor://auth/cb"],
    });
  });

  it("gives confidential clients a secret", async () => {
    const c = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(c.client_secret).toMatch(/^pls_/);
  });
});

describe("the authorization code flow", () => {
  it("connects Claude.ai: challenge, sign-in, consent, token, /mcp, refresh", async () => {
    const { browser } = await world();
    // 1. The client finds the sign-in from the 401.
    const challenge401 = await server.fetch("/mcp");
    expect(challenge401.status).toBe(401);
    expect(challenge401.headers.get("www-authenticate")).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
    // 2. Register and send the person to the authorize page.
    const { client_id } = await register();
    const { verifier, challenge } = pkce();
    const { res } = await authorizeAs(browser, client_id, challenge, { access: "propose" });
    expect(res.status).toBe(303);
    const back = new URL(res.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe(BASE);
    const code = back.searchParams.get("code")!;
    // 3. Exchange the code.
    const tokenRes = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    const tokens = await json<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    }>(tokenRes);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:propose" });
    // 4. The access token gets past the /mcp gate (the MCP server itself is T27).
    const mcp = await server.fetch("/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(mcp.status).toBe(501);
    // 5. Refresh rotates both tokens.
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id,
    });
    expect(refreshed.status).toBe(200);
    const next = await json<{ access_token: string; refresh_token: string }>(refreshed);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    // 6. Using the old refresh token again means it leaked: the whole grant ends.
    const replay = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id,
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    const after = await server.fetch("/mcp", {
      headers: { authorization: `Bearer ${next.access_token}` },
    });
    expect(after.status).toBe(401);
    expect(server.store.audit.query({ action: "oauth.grant_ended" })).toHaveLength(1);
    expect(server.store.audit.query({ action: "oauth.grant_created" })).toHaveLength(1);
  });

  it("checks PKCE, the return address and the client on the token endpoint", async () => {
    await world();
    const { client_id } = await register();
    const { verifier, challenge } = pkce();
    const approve = async () => {
      const b = new Client(server);
      const { res } = await authorizeAs(b, client_id, challenge);
      return new URL(res.headers.get("location")!).searchParams.get("code")!;
    };
    const base = { grant_type: "authorization_code", redirect_uri: REDIRECT, client_id };
    const wrongVerifier = await tokenRequest({
      ...base,
      code: await approve(),
      code_verifier: pkce().verifier,
    });
    expect(await wrongVerifier.json()).toMatchObject({ error: "invalid_grant" });
    const wrongRedirect = await tokenRequest({
      ...base,
      redirect_uri: "https://claude.example/other",
      code: await approve(),
      code_verifier: verifier,
    });
    expect(await wrongRedirect.json()).toMatchObject({ error: "invalid_grant" });
    const other = await register();
    const otherClient = await tokenRequest({
      ...base,
      client_id: other.client_id,
      code: await approve(),
      code_verifier: verifier,
    });
    expect(await otherClient.json()).toMatchObject({ error: "invalid_grant" });
    const missing = await tokenRequest({ ...base, code: await approve() });
    expect(await missing.json()).toMatchObject({ error: "invalid_request" });
    const unsupported = await tokenRequest({ grant_type: "password", client_id });
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_grant_type" });
    // A code works once; a second try ends the grant it created.
    const code = await approve();
    const ok = await tokenRequest({ ...base, code, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const { access_token } = await json<{ access_token: string }>(ok);
    const again = await tokenRequest({ ...base, code, code_verifier: verifier });
    expect(again.status).toBe(400);
    const dead = await server.fetch("/mcp", {
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(dead.status).toBe(401);
  });

  it("requires S256 PKCE and bounces other mistakes back to the app", async () => {
    const { browser } = await world();
    const { client_id } = await register();
    const { challenge } = pkce();
    const noPkce = authorizeQuery(client_id, challenge);
    noPkce.delete("code_challenge");
    const a = await browser.request(`/oauth/authorize?${noPkce}`, { redirect: "manual" });
    expect(a.status).toBe(303);
    const to = new URL(a.headers.get("location")!);
    expect(to.searchParams.get("error")).toBe("invalid_request");
    expect(to.searchParams.get("state")).toBe("xyz");
    const plain = await browser.request(
      `/oauth/authorize?${authorizeQuery(client_id, challenge, { code_challenge_method: "plain" })}`,
      { redirect: "manual" },
    );
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe(
      "invalid_request",
    );
    const badResource = await browser.request(
      `/oauth/authorize?${authorizeQuery(client_id, challenge, { resource: "https://elsewhere.example/mcp" })}`,
      { redirect: "manual" },
    );
    expect(new URL(badResource.headers.get("location")!).searchParams.get("error")).toBe(
      "invalid_target",
    );
  });

  it("never redirects to an address the client did not register", async () => {
    const { browser } = await world();
    const { client_id } = await register();
    const { challenge } = pkce();
    const evil = await browser.request(
      `/oauth/authorize?${authorizeQuery(client_id, challenge, { redirect_uri: "https://evil.example/cb" })}`,
      { redirect: "manual" },
    );
    expect(evil.status).toBe(400);
    expect(evil.headers.get("location")).toBeNull();
    const unknown = await browser.request(`/oauth/authorize?${authorizeQuery("nope", challenge)}`, {
      redirect: "manual",
    });
    expect(unknown.status).toBe(400);
  });

  it("lets the person say no", async () => {
    const { browser } = await world();
    const { client_id } = await register();
    const { res } = await authorizeAs(browser, client_id, pkce().challenge, { decision: "deny" });
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("xyz");
    expect(server.store.audit.query({ action: "oauth.grant_created" })).toHaveLength(0);
  });

  it("rejects a forged or missing CSRF token and a foreign origin", async () => {
    const { browser } = await world();
    const { client_id } = await register();
    const { challenge } = pkce();
    const { csrf, fields } = await authorizeAs(browser, client_id, challenge, { decision: "deny" });
    expect(csrf).toBeTruthy();
    const forged = await browser.request("/oauth/authorize", {
      ...form({ ...fields, csrf: "nope", decision: "allow", access: "write" }),
      redirect: "manual",
    });
    expect(forged.status).toBe(403);
    const foreign = await browser.request("/oauth/authorize", {
      ...form({ ...fields, csrf, decision: "allow", access: "write" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      redirect: "manual",
    });
    expect(foreign.status).toBe(403);
    expect(server.store.audit.query({ action: "oauth.grant_created" })).toHaveLength(0);
  });

  it("shows a wrong password on the page and honours the browser language", async () => {
    await world();
    const { client_id } = await register();
    const q = authorizeQuery(client_id, pkce().challenge);
    const page = await server.fetch(`/oauth/authorize?${q}`, {
      headers: { "accept-language": "zh-TW,zh;q=0.9" },
    });
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain('lang="zh-TW"');
    expect(html).toContain("登入");
    const bad = await server.fetch("/oauth/login", {
      ...form({ ...Object.fromEntries(q), username: "mia", password: "wrong password!!" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept-language": "en",
      },
    });
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("The name or password is wrong.");
  });

  it("escapes what an app calls itself", async () => {
    const { browser } = await world();
    const { client_id } = await register({ client_name: '<img src=x onerror=alert(1)>"' });
    const q = authorizeQuery(client_id, pkce().challenge);
    await browser.request("/oauth/login", {
      ...form({ ...Object.fromEntries(q), username: "mia", password: PASSWORD }),
      redirect: "manual",
    });
    const html = await (await browser.request(`/oauth/authorize?${q}`)).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&#34;"); // the quote is escaped, so it cannot break out of an attribute
  });

  it("refuses people who may not connect AI anywhere", async () => {
    await world();
    await server.auth.createAccount({ username: "loner", password: PASSWORD });
    const browser = new Client(server);
    const { client_id } = await register();
    const q = authorizeQuery(client_id, pkce().challenge);
    await browser.request("/oauth/login", {
      ...form({ ...Object.fromEntries(q), username: "loner", password: PASSWORD }),
      redirect: "manual",
    });
    const page = await browser.request(`/oauth/authorize?${q}`);
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("not allowed to connect AI");
  });

  it("serves confidential clients only with their secret", async () => {
    await world();
    const c = await register({ token_endpoint_auth_method: "client_secret_post" });
    const { verifier, challenge } = pkce();
    const approve = async () => {
      const { res } = await authorizeAs(new Client(server), c.client_id, challenge);
      return new URL(res.headers.get("location")!).searchParams.get("code")!;
    };
    const base = {
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    };
    const noSecret = await tokenRequest({ ...base, code: await approve(), client_id: c.client_id });
    expect(noSecret.status).toBe(401);
    expect(await noSecret.json()).toMatchObject({ error: "invalid_client" });
    const ok = await tokenRequest({
      ...base,
      code: await approve(),
      client_id: c.client_id,
      client_secret: c.client_secret!,
    });
    expect(ok.status).toBe(200);
    const basic = await server.fetch("/oauth/token", {
      ...form({ ...base, code: await approve() }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}`,
      },
    });
    expect(basic.status).toBe(200);
  });
});

describe("ending a connection", () => {
  async function connected() {
    const { browser } = await world();
    const { client_id } = await register();
    const { verifier, challenge } = pkce();
    const { res } = await authorizeAs(browser, client_id, challenge);
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const tokens = await json<{ access_token: string; refresh_token: string }>(
      await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        client_id,
      }),
    );
    return { browser, client_id, tokens };
  }
  const works = async (token: string) =>
    (await server.fetch("/mcp", { headers: { authorization: `Bearer ${token}` } })).status === 501;

  it("is revoked from the person's AI connections", async () => {
    const { tokens, client_id } = await connected();
    const mia = new Client(server);
    await mia.login("mia");
    const list = await json<{ grants: { id: string; clientName: string; access: string }[] }>(
      await mia.get("/api/oauth/grants"),
    );
    expect(list.grants).toHaveLength(1);
    expect(list.grants[0]).toMatchObject({ clientName: "Claude", access: "write" });
    expect(await works(tokens.access_token)).toBe(true);
    expect((await mia.del(`/api/oauth/grants/${list.grants[0]!.id}`)).status).toBe(204);
    expect(await works(tokens.access_token)).toBe(false);
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id,
    });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("is revoked by the app (RFC 7009)", async () => {
    const { client_id, tokens } = await connected();
    const res = await server.fetch(
      "/oauth/revoke",
      form({ token: tokens.refresh_token, client_id }),
    );
    expect(res.status).toBe(200);
    expect(await works(tokens.access_token)).toBe(false);
  });

  it("stops when the person is disabled", async () => {
    const { tokens } = await connected();
    expect(await works(tokens.access_token)).toBe(true);
    const mia = server.store.accounts.getByUsername("mia")!;
    server.store.accounts.update(mia.id, { disabled: true });
    expect(await works(tokens.access_token)).toBe(false);
  });

  it("rate limits registration per address", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const res = await server.fetch("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
