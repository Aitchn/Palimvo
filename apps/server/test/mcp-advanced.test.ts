import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { maskOf } from "@palimvo/core";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const BASE = "https://palimvo.test";
const REDIRECT = "https://claude.example/callback";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer({ publicUrl: BASE });
});
afterEach(() => server.dispose());

type Result = { isError?: boolean; content: { type: string; text?: string }[] };
// Results are poked at freely; their shape is checked by the assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const body = (r: unknown): Json => JSON.parse((r as Result).content[0]!.text!) as Json;

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

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

let cachedWorld: ReturnType<typeof makeWorld> | undefined;
beforeEach(() => {
  cachedWorld = undefined;
});
/** One world per test: later calls get the same accounts. */
const world = () => (cachedWorld ??= makeWorld());

async function makeWorld() {
  const root = await signIn("root", true);
  expect((await root.client.post("/api/vaults", { id: "a" })).status).toBe(201);
  const mia = await signIn("mia");
  server.store.joinVault("a", mia.id, "member");
  return { root, mia };
}

async function connectWith(path: string, secret: string, headers: Record<string, string> = {}) {
  const client = new McpClient({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, server.url), {
      requestInit: { headers: { authorization: `Bearer ${secret}`, ...headers } },
    }),
  );
  const call = async (tool: string, args: Record<string, unknown> = {}) =>
    body(await client.callTool({ name: tool, arguments: args }));
  /** Runs an advanced tool through the entry tool, as an AI client would. */
  const advanced = (name: string, args: Record<string, unknown> = {}) =>
    call("call_tool", { name, arguments: args });
  return { client, call, advanced };
}

/** The "Creator" role: may make vaults, so may hand that on to an app. */
function makeCreator(accountId: string) {
  const role = server.store.roles.create({
    name: "Creator",
    position: 10,
    permissions: maskOf(["vaults.create"]),
  });
  server.store.roles.assign(role.id, accountId);
  server.auth.access.invalidate();
}

async function apiToken(who: { client: Client }, extra: Record<string, unknown> = {}) {
  const res = await who.client.post("/api/tokens", { name: "t", access: "write", ...extra });
  expect(res.status).toBe(201);
  return (await json<{ secret: string }>(res)).secret;
}

/** The full OAuth round trip in a browser; returns the access token the app ends up with. */
async function oauthToken(user: string, opts: { admin?: boolean; access?: string } = {}) {
  const reg = await server.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
  });
  const { client_id } = await json<{ client_id: string }>(reg);
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: "mcp:write",
    resource: `${BASE}/mcp`,
  });
  const fields = Object.fromEntries(q);
  const browser = new Client(server);
  const login = await browser.request("/oauth/login", {
    ...form({ ...fields, username: user, password: PASSWORD }),
    redirect: "manual",
  });
  const consentHtml = await (await browser.request(login.headers.get("location")!)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(consentHtml)![1]!;
  const res = await browser.request("/oauth/authorize", {
    ...form({
      ...fields,
      csrf,
      decision: "allow",
      access: opts.access ?? "write",
      ...(opts.admin ? { admin: "1" } : {}),
    }),
    redirect: "manual",
  });
  const location = res.headers.get("location")!;
  if (res.status !== 303) return { status: res.status, consentHtml };
  const code = new URL(location).searchParams.get("code")!;
  const tokens = await json<{ access_token: string }>(
    await server.fetch("/oauth/token", {
      ...form({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        client_id,
      }),
    }),
  );
  return { status: 303, token: tokens.access_token, consentHtml };
}

const names = async (c: Awaited<ReturnType<typeof connectWith>>) =>
  (await c.call("list_tools", { limit: 100 })).tools.map((t: { name: string }) => t.name);

describe("administration through OAuth", () => {
  it("shows the box only to people who can administer, and only with write access counts", async () => {
    const { mia: miaAccount } = await world();
    const root = await oauthToken("root");
    expect(root.consentHtml).toContain('name="admin"');
    const mia = await oauthToken("mia");
    expect(mia.consentHtml).not.toContain('name="admin"');
    // Forged: mia has nothing to hand over.
    expect((await oauthToken("mia", { admin: true })).status).toBe(400);
    makeCreator(miaAccount.id);
    expect((await oauthToken("mia")).consentHtml).toContain('name="admin"');
    // The flag only makes sense for read-and-write.
    expect((await oauthToken("root", { admin: true, access: "propose" })).status).toBe(400);
    expect((await oauthToken("root", { admin: true, access: "read" })).status).toBe(400);
  });

  it("lists the grant as able to administer, and revoking ends it", async () => {
    const { root } = await world();
    const plain = await oauthToken("root");
    const admin = await oauthToken("root", { admin: true });
    const list = await json<{ grants: { id: string; admin: boolean }[] }>(
      await root.client.get("/api/oauth/grants"),
    );
    expect(list.grants.map((g) => g.admin).sort()).toEqual([false, true]);
    expect(plain.token).toBeDefined();
    const c = await connectWith("/mcp", admin.token!);
    expect(await names(c)).toContain("create_vault");
    const grant = list.grants.find((g) => g.admin)!;
    expect((await root.client.del(`/api/oauth/grants/${grant.id}`)).status).toBe(204);
    await expect(connectWith("/mcp", admin.token!)).rejects.toThrow();
  });

  it("offers create_vault and remove_vault only to an admin grant on /mcp", async () => {
    const { root } = await world();
    const withFlag = await connectWith("/mcp", (await oauthToken("root", { admin: true })).token!);
    const without = await connectWith("/mcp", (await oauthToken("root")).token!);
    const apiTok = await connectWith("/mcp", await apiToken(root));
    const oneVault = await connectWith(
      "/mcp/a",
      (await oauthToken("root", { admin: true })).token!,
    );
    expect(await names(withFlag)).toEqual(expect.arrayContaining(["create_vault", "remove_vault"]));
    for (const c of [without, apiTok, oneVault]) {
      const listed = await names(c);
      expect(listed).not.toContain("create_vault");
      expect(listed).not.toContain("remove_vault");
    }
    const refused = await apiTok.advanced("create_vault", { id: "x", reason: "try" });
    expect(refused.error.code).toBe("forbidden");
    expect(refused.error.message).toContain("allowed to administer");
    expect(
      (await without.advanced("remove_vault", { vault: "a", confirm: "a", reason: "t" })).error
        .code,
    ).toBe("forbidden");
  });

  it("creates a vault the person administers, and checks the id", async () => {
    const { root } = await world();
    const c = await connectWith("/mcp", (await oauthToken("root", { admin: true })).token!);
    expect(await c.advanced("create_vault", { id: "notes", reason: "new team" })).toMatchObject({
      id: "notes",
    });
    expect(
      server.store.accounts.listMemberships(root.id).find((m) => m.vaultId === "notes"),
    ).toMatchObject({
      position: "admin",
    });
    expect((await c.call("list_vaults")).vaults.map((v: { id: string }) => v.id)).toContain(
      "notes",
    );
    expect((await c.advanced("create_vault", { id: "notes", reason: "again" })).error.code).toBe(
      "already_exists",
    );
    expect((await c.advanced("create_vault", { id: "../x", reason: "bad" })).error.code).toBe(
      "invalid_request",
    );
    expect((await c.advanced("create_vault", { id: "nope" })).error.code).toBe("invalid_request");
    expect(server.store.audit.query({ action: "vault.created" })).toHaveLength(2);
  });

  it("removes a vault only into the trash, after confirmation, for someone who may change its settings", async () => {
    const { root, mia } = await world();
    const admin = await connectWith("/mcp", (await oauthToken("root", { admin: true })).token!);
    await admin.advanced("create_vault", { id: "old", reason: "x" });
    await admin.call("create_note", { vault: "old", path: "Keep.md", content: "k", reason: "x" });

    const wrong = await admin.advanced("remove_vault", {
      vault: "old",
      confirm: "older",
      reason: "r",
    });
    expect(wrong.error.code).toBe("invalid_request");
    expect((await admin.call("list_vaults")).vaults.map((v: { id: string }) => v.id)).toContain(
      "old",
    );
    expect(
      (await admin.advanced("remove_vault", { vault: "old", confirm: "old" })).error.message,
    ).toContain("reason");

    const gone = await admin.advanced("remove_vault", {
      vault: "old",
      confirm: "old",
      reason: "merged",
    });
    expect(gone.removed).toBe("old");
    expect((await admin.call("list_vaults")).vaults.map((v: { id: string }) => v.id)).toEqual([
      "a",
    ]);
    const trashed = await json<{ removed: { id: string; name: string }[] }>(
      await root.client.get("/api/removed-vaults"),
    );
    expect(trashed.removed.map((r) => r.id)).toEqual(["old"]);
    expect(server.store.audit.query({ action: "vault.removed" })).toHaveLength(1);
    expect(
      (await root.client.post(`/api/removed-vaults/${trashed.removed[0]!.name}/restore`, {}))
        .status,
    ).toBe(200);

    // A creator who is only a member of "a" holds no vault.settings there, grant or not.
    makeCreator(mia.id);
    const memberConn = await connectWith("/mcp", (await oauthToken("mia", { admin: true })).token!);
    expect(await names(memberConn)).toContain("create_vault");
    expect(await names(memberConn)).not.toContain("remove_vault");
    const refused = await memberConn.advanced("remove_vault", {
      vault: "a",
      confirm: "a",
      reason: "no",
    });
    expect(refused.error.code).toBe("forbidden");
    expect((await root.client.get("/api/vaults")).status).toBe(200);
  });

  it("lets a vault administrator without server rights remove their vault with an admin grant", async () => {
    await world();
    const owner = await signIn("owner");
    makeCreator(owner.id);
    expect((await owner.client.post("/api/vaults", { id: "mine" })).status).toBe(201);
    const c = await connectWith("/mcp", (await oauthToken("owner", { admin: true })).token!);
    expect(await names(c)).toContain("remove_vault");
    expect(
      (await c.advanced("remove_vault", { vault: "mine", confirm: "mine", reason: "done" }))
        .removed,
    ).toBe("mine");
    // The grant is cut down by the person's rights on every call: once they are no longer a creator, create_vault goes.
    expect(await names(c)).toContain("create_vault");
    for (const role of server.store.roles.rolesOf(owner.id))
      server.store.roles.unassign(role.id, owner.id);
    server.auth.access.invalidate();
    expect(await names(c)).not.toContain("create_vault");
  });
});

/** A write-capable API token for vault `a`. */
async function aiOnA(extra: Record<string, unknown> = {}) {
  const { mia } = await world();
  const secret = await apiToken(mia, { vaultId: "a", ...extra });
  return connectWith("/mcp/a", secret, { "x-palimvo-author": "ai:Claude%20Code" });
}

describe("advanced tools through the entry tools", () => {
  it("lists them with one line each", async () => {
    const c = await aiOnA();
    const listed = await names(c);
    expect(listed).toEqual(
      expect.arrayContaining([
        "create_folder",
        "get_graph",
        "create_checkpoint",
        "restore_version",
        "create_base",
        "list_file_types",
      ]),
    );
    const described = await c.call("describe_tool", { name: "create_base" });
    expect(described.writes).toBe(true);
    expect(described.arguments.properties.reason).toBeDefined();
  });

  it("creates folders", async () => {
    const c = await aiOnA();
    expect(await c.advanced("create_folder", { path: "Projects/2026", reason: "plan" })).toEqual({
      path: "Projects/2026",
    });
    expect((await c.call("list_files", { folder: "Projects" })).entries).toEqual([
      { path: "Projects/2026", type: "folder" },
    ]);
    expect(
      (await c.advanced("create_folder", { path: "Projects/2026", reason: "again" })).error.code,
    ).toBe("already_exists");
  });

  it("shows the link graph", async () => {
    const c = await aiOnA();
    await c.call("create_note", {
      path: "A.md",
      content: "see [[B]] and [[Missing]]",
      reason: "r",
    });
    await c.call("create_note", { path: "B.md", content: "back to [[A]]", reason: "r" });
    await c.call("create_note", { path: "Lonely.md", content: "alone", reason: "r" });
    const graph = await c.advanced("get_graph");
    expect(graph.nodes.map((n: { path: string }) => n.path).sort()).toEqual(
      expect.arrayContaining(["A.md", "B.md", "Lonely.md"]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: "A.md", to: "B.md", embed: false },
        { from: "B.md", to: "A.md", embed: false },
      ]),
    );
    expect(graph.unresolved).toContainEqual({ from: "A.md", target: "Missing" });
    const small = await c.advanced("get_graph", { limit: 2 });
    expect(small.nodes.map((n: { path: string }) => n.path).sort()).toEqual(["A.md", "B.md"]);
    expect(small).toMatchObject({ truncated: true });
  });

  it("limits the graph of a folder-limited token to its folders", async () => {
    const full = await aiOnA();
    await full.call("create_note", { path: "Open/A.md", content: "[[Secret]]", reason: "r" });
    await full.call("create_note", { path: "Closed/Secret.md", content: "[[A]]", reason: "r" });
    const { mia } = await world();
    const limited = await connectWith(
      "/mcp/a",
      await apiToken(mia, { vaultId: "a", folders: ["Open"] }),
    );
    const graph = await limited.advanced("get_graph");
    expect(graph.nodes.map((n: { path: string }) => n.path)).toEqual(["Open/A.md"]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolved).toEqual([]);
  });

  it("saves checkpoints and puts files back", async () => {
    const c = await aiOnA();
    await c.call("create_note", { path: "Plan.md", content: "v1", reason: "start" });
    const cp = await c.advanced("create_checkpoint", { tag: "v1", reason: "First draft done" });
    expect(cp.tags).toEqual(["v1"]);
    expect((await c.advanced("create_checkpoint", { tag: "v1", reason: "dup" })).error.code).toBe(
      "already_exists",
    );
    await c.call("update_note", { path: "Plan.md", content: "v2", reason: "rewrite" });
    const history = await c.call("get_history", { path: "Plan.md" });
    const first = history.commits.at(-1);
    const restored = await c.advanced("restore_version", {
      path: "Plan.md",
      commit: cp.id,
      reason: "Back to the first draft",
    });
    expect(restored.path).toBe("Plan.md");
    expect((await c.call("read_note", { path: "Plan.md" })).content).toBe("v1");
    expect(first).toBeDefined();
    expect(
      (await c.advanced("restore_version", { path: "Nope.md", commit: cp.id, reason: "x" })).error
        .code,
    ).toBe("not_found");
    const log = await c.call("get_history", { limit: 3 });
    expect(log.commits[0].author.name).toBe("Claude Code");
  });

  it("refuses restore and checkpoints to read-only and propose-only tokens", async () => {
    const { mia } = await world();
    const reader = await connectWith(
      "/mcp/a",
      await apiToken(mia, { vaultId: "a", access: "read" }),
    );
    const listed = await names(reader);
    for (const w of ["create_folder", "create_checkpoint", "restore_version", "create_base"])
      expect(listed).not.toContain(w);
    expect(listed).toEqual(expect.arrayContaining(["get_graph", "list_file_types"]));
    const refused = await reader.advanced("create_checkpoint", { reason: "no" });
    expect(refused.error.code).toBe("token_scope_denied");
  });

  it("keeps a folder-limited token from restoring or reading outside its folders", async () => {
    const full = await aiOnA();
    await full.call("create_note", { path: "Closed/S.md", content: "one", reason: "r" });
    const cp = await full.advanced("create_checkpoint", { reason: "cp" });
    await full.call("update_note", { path: "Closed/S.md", content: "two", reason: "r" });
    const { mia } = await world();
    const limited = await connectWith(
      "/mcp/a",
      await apiToken(mia, { vaultId: "a", folders: ["Open"] }),
    );
    const r = await limited.advanced("restore_version", {
      path: "Closed/S.md",
      commit: cp.id,
      reason: "x",
    });
    expect(r.error.code).toBeDefined();
    expect((await full.call("read_note", { path: "Closed/S.md" })).content).toBe("two");
  });

  it("creates databases from a folder or tags", async () => {
    const c = await aiOnA();
    await c.call("create_note", {
      path: "Tasks/One.md",
      content: "---\nstatus: open\ntags: [work]\n---\n",
      reason: "r",
    });
    await c.call("create_note", {
      path: "Other/Two.md",
      content: "---\nstatus: open\n---\n",
      reason: "r",
    });
    const made = await c.advanced("create_base", {
      path: "Tasks",
      folder: "Tasks",
      columns: ["file.name", "status"],
      reason: "task list",
    });
    expect(made.path).toBe("Tasks.base");
    const rows = await c.call("query_base", { path: "Tasks.base" });
    expect(rows.rows.map((r: { path: string }) => r.path)).toEqual(["Tasks/One.md"]);
    expect(rows.columns.map((col: { id: string }) => col.id)).toEqual(["file.name", "status"]);

    await c.advanced("create_base", {
      path: "Work.base",
      tags: ["#work"],
      view: "cards",
      reason: "r",
    });
    expect(
      (await c.call("query_base", { path: "Work.base" })).rows.map((r: { path: string }) => r.path),
    ).toEqual(["Tasks/One.md"]);

    expect(
      (await c.advanced("create_base", { path: "Tasks.base", reason: "again" })).error.code,
    ).toBe("already_exists");
    expect((await c.advanced("create_base", { path: "x.md", reason: "r" })).error.code).toBe(
      "invalid_request",
    );
    expect(
      (await c.advanced("create_base", { path: "q.base", folder: 'a"b', reason: "r" })).error.code,
    ).toBe("invalid_path");
  });

  it("lists the file types and limits", async () => {
    const c = await aiOnA();
    const types = await c.advanced("list_file_types");
    expect(types.media.image).toContain("png");
    expect(types.documents).toEqual(expect.arrayContaining(["pdf", "json"]));
    expect(types.max_bytes).toBe(64 * 1024 * 1024);
  });
});
