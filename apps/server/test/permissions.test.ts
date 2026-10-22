import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskOf, type PermissionName } from "@palimvo/core";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
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

/** An administrator, a vault `v` with a few files, and a plain member `mia` who joined it. */
async function world() {
  const root = await signIn("root", true);
  expect((await root.client.post("/api/vaults", { id: "v" })).status).toBe(201);
  for (const [path, content] of [
    ["a.md", "alpha [[b]]"],
    ["b.md", "beta"],
    ["open/n.md", "open note"],
    ["locked/s.md", "locked note"],
  ] as const)
    expect((await root.client.put(`/api/vaults/v/files/${path}`, { content })).status).toBe(200);
  const mia = await signIn("mia");
  store().joinVault("v", mia.id, "member");
  return { root, mia };
}

const setOverride = (
  vaultId: string | null,
  subject: { type: "role" | "account"; id: string },
  allow: PermissionName[],
  deny: PermissionName[],
  folder?: string,
) =>
  store().roles.setOverride(
    vaultId === null
      ? { scope: "server", subjectType: subject.type, subjectId: subject.id }
      : {
          scope: folder === undefined ? "vault" : "folder",
          vaultId,
          ...(folder === undefined ? {} : { folder }),
          subjectType: subject.type,
          subjectId: subject.id,
        },
    { allow: maskOf(allow), deny: maskOf(deny) },
  );

/** The id of the newest commit of vault `v`. */
async function latestCommit(client: Client): Promise<string> {
  await server.services.history.flushAll();
  const { commits } = await json<{ commits: { id?: string; hash?: string }[] }>(
    await client.get("/api/vaults/v/history"),
  );
  const last = commits[0]!;
  return (last.id ?? last.hash)!;
}

interface Case {
  permission: PermissionName;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  json?: unknown;
  /** Further permissions the route needs. */
  also?: PermissionName[];
}

const V = "/api/vaults/v";
const VAULT_CASES: Case[] = [
  { permission: "note.read", method: "GET", path: `${V}/files` },
  { permission: "note.read", method: "GET", path: `${V}/files/a.md` },
  { permission: "note.read", method: "GET", path: `${V}/search?q=alpha` },
  { permission: "note.read", method: "GET", path: `${V}/backlinks?path=b.md` },
  { permission: "note.read", method: "GET", path: `${V}/links?path=a.md` },
  { permission: "note.read", method: "GET", path: `${V}/graph` },
  { permission: "note.read", method: "GET", path: `${V}/archive` },
  { permission: "note.write", method: "PUT", path: `${V}/files/new.md`, json: { content: "x" } },
  { permission: "note.write", method: "POST", path: `${V}/folders`, json: { path: "fresh" } },
  {
    permission: "note.write",
    method: "POST",
    path: `${V}/batch`,
    json: { writes: [{ path: "batch.md", baseVersion: null, content: "x" }] },
  },
  { permission: "note.write", method: "POST", path: `${V}/checkpoints`, json: { message: "cp" } },
  { permission: "note.delete", method: "DELETE", path: `${V}/files/b.md` },
  { permission: "history.view", method: "GET", path: `${V}/history` },
  { permission: "history.view", method: "GET", path: `${V}/checkpoints` },
  {
    permission: "history.restore",
    method: "POST",
    path: `${V}/restore`,
    json: { path: "a.md", commit: "HEAD" },
    also: ["note.write"],
  },
  { permission: "vault.settings", method: "GET", path: `${V}/backup` },
  { permission: "members.manage", method: "GET", path: `${V}/members` },
  { permission: "permissions.manage", method: "GET", path: `${V}/permissions` },
  { permission: "public.manage", method: "GET", path: `${V}/public` },
];

const SERVER_CASES: Case[] = [
  { permission: "users.manage", method: "GET", path: "/api/admin/users" },
  { permission: "users.manage", method: "GET", path: "/api/admin/invites" },
  { permission: "roles.manage", method: "GET", path: "/api/admin/permissions" },
  { permission: "server.manage", method: "GET", path: "/api/removed-vaults" },
  { permission: "vaults.create", method: "POST", path: "/api/vaults", json: { id: "made" } },
];

describe("every permission against every kind of API", () => {
  it.each(VAULT_CASES)("$permission guards $method $path", async (c) => {
    const { root, mia } = await world();
    await root.client.post(`${V}/checkpoints`, { message: "base" });
    await server.services.history.flushAll();
    const need = [c.permission, ...(c.also ?? [])];
    const body = c.path.endsWith("/restore")
      ? { ...(c.json as object), commit: await latestCommit(root.client) }
      : c.json;
    const call = () => mia.client.request(c.path, { method: c.method, json: body });
    const subject = { type: "account", id: mia.id } as const;

    // Denied: the person is a member but this one permission is taken away.
    setOverride("v", subject, [], [c.permission]);
    const denied = await call();
    expect(denied.status, `${c.method} ${c.path} should be forbidden`).toBe(403);
    expect(await json(denied)).toMatchObject({ code: "forbidden" });

    // Allowed: granted explicitly, so permissions members lack by default are covered too.
    setOverride("v", subject, need, []);
    const allowed = await call();
    expect(allowed.status, `${c.method} ${c.path} -> ${await allowed.clone().text()}`).toBeLessThan(
      300,
    );
  });

  it.each(VAULT_CASES)("hides the vault from outsiders for $method $path", async (c) => {
    const { root } = await world();
    await root.client.post(`${V}/checkpoints`, { message: "base" });
    const outsider = await signIn("olga");
    const res = await outsider.client.request(c.path, { method: c.method, json: c.json });
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ code: "vault_not_found" });
  });

  it.each(SERVER_CASES)("$permission guards $method $path", async (c) => {
    const { mia } = await world();
    const call = () => mia.client.request(c.path, { method: c.method, json: c.json });
    expect((await call()).status).toBe(403);
    const everyone =
      store().roles.getEveryone() ??
      store().roles.create({ name: "@everyone", position: 0, isEveryone: true });
    setOverride(null, { type: "role", id: everyone.id }, [c.permission], []);
    const res = await call();
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  });

  it("answers guests with a sign-in request, never data, for everything but public reads", async () => {
    await world();
    const guest = new Client(server);
    for (const c of [...VAULT_CASES, ...SERVER_CASES])
      expect([401, 404], `${c.method} ${c.path}`).toContain(
        (await guest.request(c.path, { method: c.method, json: c.json })).status,
      );
  });

  it("leaves everything open until the first account exists", async () => {
    const anon = new Client(server);
    expect((await anon.post("/api/vaults", { id: "v" })).status).toBe(201);
    expect((await anon.put("/api/vaults/v/files/a.md", { content: "x" })).status).toBe(200);
  });
});

describe("folder rules", () => {
  async function locked() {
    const w = await world();
    setOverride(
      "v",
      { type: "account", id: w.mia.id },
      [],
      ["note.write", "note.delete"],
      "locked",
    );
    return w;
  }

  it("blocks writing, creating and deleting inside a restricted folder only", async () => {
    const { mia } = await locked();
    const put = (p: string) => mia.client.put(`${V}/files/${p}`, { content: "x" });
    expect((await put("locked/new.md")).status).toBe(403);
    expect((await put("locked/deep/er.md")).status).toBe(403); // inherited by subfolders
    expect((await put("open/new.md")).status).toBe(200);
    expect((await put("Locked/new.md")).status).toBe(403); // case-insensitive, like the file system rules
    expect((await put("open/../locked/sneaky.md")).status).toBeGreaterThanOrEqual(400);
    expect((await mia.client.post(`${V}/folders`, { path: "locked/sub" })).status).toBe(403);
    expect((await mia.client.del(`${V}/files/locked/s.md`)).status).toBe(403);
    expect((await mia.client.del(`${V}/files/open/n.md`)).status).toBe(204);
    // Reading is untouched.
    expect((await mia.client.get(`${V}/files/locked/s.md`)).status).toBe(200);
  });

  it("checks every path of a batch before writing any", async () => {
    const { mia, root } = await locked();
    const res = await mia.client.post(`${V}/batch`, {
      writes: [
        { path: "fine.md", baseVersion: null, content: "x" },
        { path: "locked/no.md", baseVersion: null, content: "x" },
      ],
    });
    expect(res.status).toBe(403);
    expect((await root.client.get(`${V}/files/fine.md`)).status).toBe(404);
  });

  it("blocks moving files into and out of a restricted folder", async () => {
    const { mia } = await locked();
    const move = (from: string, to: string) => mia.client.post(`${V}/move`, { from, to });
    expect((await move("open/n.md", "locked/n.md")).status).toBe(403); // into: needs write there
    expect((await move("locked/s.md", "open/s.md")).status).toBe(403); // out of: needs delete there
    expect((await move("open/n.md", "open/m.md")).status).toBe(200);
  });

  it("does not let deleting or moving a parent get around a rule further down", async () => {
    const { mia, root } = await world();
    await root.client.put(`${V}/files/proj/keep/k.md`, { content: "k" });
    await root.client.put(`${V}/files/proj/free/f.md`, { content: "f" });
    setOverride("v", { type: "account", id: mia.id }, [], ["note.delete"], "proj/keep");
    expect((await mia.client.del(`${V}/files/proj`)).status).toBe(403);
    expect((await mia.client.post(`${V}/move`, { from: "proj", to: "moved" })).status).toBe(403);
    expect((await mia.client.del(`${V}/files/proj/free`)).status).toBe(204);
  });

  it("blocks restoring an old version into a restricted folder", async () => {
    const { mia, root } = await locked();
    await server.services.history.flushAll();
    const commit = await latestCommit(root.client);
    setOverride(
      "v",
      { type: "account", id: mia.id },
      ["history.restore"],
      ["note.write"],
      "locked",
    );
    const res = await mia.client.post(`${V}/restore`, {
      path: "locked/s.md",
      commit,
    });
    expect(res.status).toBe(403);
  });
});

describe("roles", () => {
  it("lets a role's holders do what it grants, and nothing before it is given", async () => {
    const { root, mia } = await world();
    const role = await json<{ id: string }>(
      await root.client.post("/api/admin/roles", {
        name: "Creator",
        permissions: ["vaults.create"],
      }),
    );
    expect((await mia.client.post("/api/vaults", { id: "mine" })).status).toBe(403);
    expect((await root.client.put(`/api/admin/users/${mia.id}/roles/${role.id}`)).status).toBe(204);
    expect((await mia.client.post("/api/vaults", { id: "mine" })).status).toBe(201);
    // The creator administers what they created, and sees only what they belong to.
    expect(store().accounts.getMember("mine", mia.id)?.position).toBe("admin");
    expect((await mia.client.get("/api/vaults/mine/members")).status).toBe(200);
    expect((await root.client.del(`/api/admin/users/${mia.id}/roles/${role.id}`)).status).toBe(204);
    expect((await mia.client.post("/api/vaults", { id: "again" })).status).toBe(403);
  });

  it("applies a Reader's vault deny when they join, and when the role arrives later", async () => {
    const { root, mia } = await world();
    const reader = await json<{ id: string }>(
      await root.client.post("/api/admin/roles", {
        name: "Reader",
        joinDeny: ["note.write", "note.delete", "file.upload"],
      }),
    );
    // Role given before the vault is joined.
    const ray = await signIn("ray");
    await root.client.put(`/api/admin/users/${ray.id}/roles/${reader.id}`);
    expect((await root.client.put(`${V}/members/${ray.id}`, { position: "member" })).status).toBe(
      200,
    );
    expect((await ray.client.get(`${V}/files/a.md`)).status).toBe(200);
    expect((await ray.client.put(`${V}/files/ray.md`, { content: "x" })).status).toBe(403);
    expect((await ray.client.del(`${V}/files/a.md`)).status).toBe(403);

    // Role given to someone already in the vault.
    expect((await mia.client.put(`${V}/files/mia.md`, { content: "x" })).status).toBe(200);
    await root.client.put(`/api/admin/users/${mia.id}/roles/${reader.id}`);
    expect((await mia.client.put(`${V}/files/mia2.md`, { content: "x" })).status).toBe(403);

    // A vault administrator may relax it for their vault, and later joiners do not undo that.
    const overrides = await json<{ overrides: { subjectId: string }[] }>(
      await root.client.get(`${V}/permissions`),
    );
    expect(overrides.overrides.map((o) => o.subjectId)).toEqual([reader.id]);
    expect(
      (
        await root.client.put(`${V}/permissions`, {
          subjectType: "role",
          subjectId: reader.id,
          allow: [],
          deny: ["note.delete"],
        })
      ).status,
    ).toBe(200);
    const sam = await signIn("sam");
    await root.client.put(`/api/admin/users/${sam.id}/roles/${reader.id}`);
    await root.client.put(`${V}/members/${sam.id}`, { position: "member" });
    expect((await sam.client.put(`${V}/files/sam.md`, { content: "x" })).status).toBe(200);
    expect((await sam.client.del(`${V}/files/sam.md`)).status).toBe(403);
  });

  it("follows role changes at once", async () => {
    const { root, mia } = await world();
    const role = store().roles.create({ name: "Deny", position: 1 });
    store().grantRole(role.id, mia.id);
    setOverride("v", { type: "role", id: role.id }, [], ["note.read"]);
    expect((await mia.client.get(`${V}/files/a.md`)).status).toBe(403);
    expect((await root.client.del(`/api/admin/roles/${role.id}`)).status).toBe(204);
    expect((await mia.client.get(`${V}/files/a.md`)).status).toBe(200);
  });

  it("keeps managers below their own rank and within their own permissions", async () => {
    const { root } = await world();
    const mod = store().roles.create({
      name: "Mod",
      position: 5,
      permissions: maskOf(["roles.manage", "users.manage", "vaults.create"]),
    });
    const boss = store().roles.create({
      name: "Boss",
      position: 9,
      permissions: maskOf(["server.manage"]),
    });
    const max = await signIn("max");
    store().grantRole(mod.id, max.id);
    const post = (body: unknown) => max.client.post("/api/admin/roles", body);

    expect((await post({ name: "Helper", permissions: ["vaults.create"] })).status).toBe(201);
    expect((await post({ name: "TooHigh", position: 5 })).status).toBe(403);
    expect((await post({ name: "Powerful", permissions: ["server.manage"] })).status).toBe(403);
    expect(
      (await max.client.patch(`/api/admin/roles/${boss.id}`, { color: "#112233" })).status,
    ).toBe(403);
    expect(
      (await max.client.patch(`/api/admin/roles/${mod.id}`, { color: "#112233" })).status,
    ).toBe(403);
    expect((await max.client.del(`/api/admin/roles/${boss.id}`)).status).toBe(403);
    expect((await max.client.put(`/api/admin/users/${max.id}/roles/${boss.id}`)).status).toBe(403);
    // Raising an existing role's position above their own, or adding a permission they lack.
    const helper = store()
      .roles.list()
      .find((r) => r.name === "Helper")!;
    expect((await max.client.patch(`/api/admin/roles/${helper.id}`, { position: 7 })).status).toBe(
      403,
    );
    expect(
      (await max.client.patch(`/api/admin/roles/${helper.id}`, { permissions: ["audit.view"] }))
        .status,
    ).toBe(403);
    expect(
      (await max.client.patch(`/api/admin/roles/${helper.id}`, { permissions: ["users.manage"] }))
        .status,
    ).toBe(200);
    // The server administrator is not bound by rank.
    expect((await root.client.patch(`/api/admin/roles/${boss.id}`, { name: "Chief" })).status).toBe(
      200,
    );
  });

  it("protects @everyone and validates input", async () => {
    const { root } = await world();
    const everyone =
      store().roles.getEveryone() ??
      store().roles.create({ name: "@everyone", position: 0, isEveryone: true });
    expect((await root.client.del(`/api/admin/roles/${everyone.id}`)).status).toBe(403);
    expect((await root.client.patch(`/api/admin/roles/${everyone.id}`, { name: "x" })).status).toBe(
      403,
    );
    expect(
      (
        await root.client.patch(`/api/admin/roles/${everyone.id}`, {
          permissions: ["assistant.use"],
        })
      ).status,
    ).toBe(200);
    expect((await root.client.put(`/api/admin/users/${root.id}/roles/${everyone.id}`)).status).toBe(
      400,
    );
    expect(
      (await root.client.post("/api/admin/roles", { name: "x", permissions: ["nope"] })).status,
    ).toBe(400);
    expect(
      (await root.client.post("/api/admin/roles", { name: "x", permissions: ["note.read"] }))
        .status,
    ).toBe(400);
    expect((await root.client.post("/api/admin/roles", { name: "x", color: "red" })).status).toBe(
      400,
    );
    expect((await root.client.post("/api/admin/roles", { name: "Dup" })).status).toBe(201);
    expect((await root.client.post("/api/admin/roles", { name: "Dup" })).status).toBe(409);
  });

  it("records every change in the audit log", async () => {
    const { root, mia } = await world();
    const role = await json<{ id: string }>(
      await root.client.post("/api/admin/roles", { name: "Aud" }),
    );
    await root.client.patch(`/api/admin/roles/${role.id}`, { color: "#abcdef" });
    await root.client.put(`/api/admin/users/${mia.id}/roles/${role.id}`);
    await root.client.put(`${V}/permissions`, {
      subjectType: "role",
      subjectId: role.id,
      deny: ["note.write"],
    });
    await root.client.put(`${V}/members/${mia.id}`, { position: "admin" });
    await root.client.del(`${V}/members/${mia.id}`);
    const actions = store()
      .audit.query({})
      .map((e) => e.action);
    for (const a of [
      "vault.created",
      "role.created",
      "role.updated",
      "role.assigned",
      "vault.permission_set",
      "vault.member_set",
      "vault.member_removed",
    ])
      expect(actions).toContain(a);
  });
});

describe("people and administrators", () => {
  it("keeps server administrators out of reach of those who only manage users", async () => {
    const { root } = await world();
    const role = store().roles.create({
      name: "HR",
      position: 3,
      permissions: maskOf(["users.manage"]),
    });
    const hr = await signIn("hr");
    store().grantRole(role.id, hr.id);
    expect((await hr.client.get("/api/admin/users")).status).toBe(200);
    expect((await hr.client.patch(`/api/admin/users/${root.id}`, { disabled: true })).status).toBe(
      403,
    );
    expect((await hr.client.post(`/api/admin/users/${root.id}/password`, {})).status).toBe(403);
    expect((await hr.client.del(`/api/admin/users/${root.id}`)).status).toBe(403);
    expect(
      (
        await hr.client.post("/api/admin/users", {
          username: "newbie",
          password: PASSWORD,
          serverAdmin: true,
        })
      ).status,
    ).toBe(403);
    expect((await hr.client.patch(`/api/admin/users/${hr.id}`, { serverAdmin: true })).status).toBe(
      403,
    );
    expect(
      (await hr.client.post("/api/admin/users", { username: "newbie", password: PASSWORD })).status,
    ).toBe(201);
  });

  it("never leaves the server without an administrator", async () => {
    const { root } = await world();
    const boss = await signIn("boss", true);
    expect(
      (await boss.client.patch(`/api/admin/users/${root.id}`, { serverAdmin: false })).status,
    ).toBe(200);
    expect(
      (await boss.client.patch(`/api/admin/users/${boss.id}`, { serverAdmin: false })).status,
    ).toBe(403);
    expect(() => store().accounts.update(boss.id, { serverAdmin: false })).toThrow();
    expect(() => store().accounts.delete(boss.id)).toThrow();
    expect(store().accounts.countServerAdmins()).toBe(1);
  });

  it("limits invites to roles and vaults the inviter may hand out", async () => {
    const { root, mia } = await world();
    const high = store().roles.create({ name: "High", position: 8 });
    const mod = store().roles.create({
      name: "Mod",
      position: 5,
      permissions: maskOf(["users.manage", "roles.manage"]),
    });
    store().grantRole(mod.id, mia.id);
    const invite = (body: unknown) => mia.client.post("/api/admin/invites", body);
    expect((await invite({ roleIds: [high.id] })).status).toBe(403);
    // Mia manages users but is only a plain member of v, so she cannot invite people into it.
    expect((await invite({ vaults: [{ vaultId: "v", position: "member" }] })).status).toBe(403);
    expect((await invite({})).status).toBe(201);
    setOverride("v", { type: "account", id: mia.id }, ["members.manage"], []);
    expect((await invite({ vaults: [{ vaultId: "v", position: "member" }] })).status).toBe(201);
    expect((await invite({ vaults: [{ vaultId: "v", position: "admin" }] })).status).toBe(403);
    expect(
      (
        await root.client.post("/api/admin/invites", {
          vaults: [{ vaultId: "v", position: "admin" }],
        })
      ).status,
    ).toBe(201);
  });

  it("shows each person only the vaults they belong to", async () => {
    const { root, mia } = await world();
    await root.client.post("/api/vaults", { id: "other" });
    const names = async (c: Client) =>
      (await json<{ vaults: { id: string }[] }>(await c.get("/api/vaults"))).vaults
        .map((v) => v.id)
        .sort();
    expect(await names(root.client)).toEqual(["other", "v"]);
    expect(await names(mia.client)).toEqual(["v"]);
  });

  it("starts a recreated vault without the old one's members", async () => {
    const { root, mia } = await world();
    expect((await root.client.del("/api/vaults/v")).status).toBe(200);
    store().accounts.setMember("v", mia.id, "member"); // stale row, as if left from the earlier vault
    expect((await root.client.post("/api/vaults", { id: "v" })).status).toBe(201);
    expect(store().accounts.getMember("v", mia.id)).toBeUndefined();
    expect((await mia.client.get("/api/vaults/v/files")).status).toBe(404);
  });
});

describe("vault members", () => {
  it("lets members managers add and remove members but not make or touch administrators", async () => {
    const { root, mia } = await world();
    setOverride("v", { type: "account", id: mia.id }, ["members.manage"], []);
    const eve = await signIn("eve");
    expect((await mia.client.put(`${V}/members/${eve.id}`, { position: "member" })).status).toBe(
      200,
    );
    expect((await mia.client.put(`${V}/members/${eve.id}`, { position: "admin" })).status).toBe(
      403,
    );
    expect((await root.client.put(`${V}/members/${eve.id}`, { position: "admin" })).status).toBe(
      200,
    );
    expect((await mia.client.put(`${V}/members/${eve.id}`, { position: "member" })).status).toBe(
      403,
    );
    expect((await mia.client.del(`${V}/members/${eve.id}`)).status).toBe(403);
    expect((await root.client.put(`${V}/members/${eve.id}`, { position: "member" })).status).toBe(
      200,
    );
    expect((await mia.client.del(`${V}/members/${eve.id}`)).status).toBe(204);
    expect((await mia.client.del(`${V}/members/${eve.id}`)).status).toBe(404);
    expect((await eve.client.get(`${V}/files/a.md`)).status).toBe(404);
    const list = await json<{ members: { account: { username: string }; position: string }[] }>(
      await mia.client.get(`${V}/members`),
    );
    expect(list.members.map((m) => m.account.username).sort()).toEqual(["mia", "root"]);
  });

  it("forgets a person's own overrides when they leave", async () => {
    const { root, mia } = await world();
    setOverride("v", { type: "account", id: mia.id }, [], ["note.write"]);
    await root.client.del(`${V}/members/${mia.id}`);
    await root.client.put(`${V}/members/${mia.id}`, { position: "member" });
    expect((await mia.client.put(`${V}/files/back.md`, { content: "x" })).status).toBe(200);
  });

  it("never lets a vault administrator be locked out by a deny", async () => {
    const { root, mia } = await world();
    await root.client.put(`${V}/members/${mia.id}`, { position: "admin" });
    setOverride(
      "v",
      { type: "account", id: mia.id },
      [],
      ["permissions.manage", "members.manage", "vault.settings"],
    );
    expect((await mia.client.get(`${V}/permissions`)).status).toBe(200);
    expect((await mia.client.get(`${V}/members`)).status).toBe(200);
  });
});

describe("vault permission overrides", () => {
  it("validates what can be set where", async () => {
    const { root, mia } = await world();
    const put = (body: Record<string, unknown>) =>
      root.client.put(`${V}/permissions`, { subjectType: "account", subjectId: mia.id, ...body });
    expect((await put({ deny: ["note.write"] })).status).toBe(200);
    expect((await put({ folder: "open", deny: ["note.write"] })).status).toBe(200);
    // Folders only change write-type permissions.
    expect((await put({ folder: "open", deny: ["members.manage"] })).status).toBe(400);
    expect((await put({ folder: "open", deny: ["note.read"] })).status).toBe(400);
    // Server-level permissions are not vault permissions.
    expect((await put({ allow: ["users.manage"] })).status).toBe(400);
    expect((await put({ deny: ["bogus"] })).status).toBe(400);
    expect((await put({ folder: "../x", deny: ["note.write"] })).status).toBe(400);
    expect((await put({ folder: "", deny: ["note.write"] })).status).toBe(400);
    expect(
      (
        await root.client.put(`${V}/permissions`, {
          subjectType: "role",
          subjectId: "nope",
          deny: ["note.write"],
        })
      ).status,
    ).toBe(404);
    // An empty override removes the row.
    expect((await put({ folder: "open" })).status).toBe(200);
    const listed = await json<{ overrides: { folder?: string }[] }>(
      await root.client.get(`${V}/permissions`),
    );
    expect(listed.overrides.map((o) => o.folder)).toEqual([undefined]);
    expect(
      (await root.client.del(`${V}/permissions?subjectType=account&subjectId=${mia.id}`)).status,
    ).toBe(204);
    expect(
      (await root.client.del(`${V}/permissions?subjectType=account&subjectId=${mia.id}`)).status,
    ).toBe(404);
  });

  it("does not let anyone grant more than they hold", async () => {
    const { mia } = await world();
    setOverride("v", { type: "account", id: mia.id }, ["permissions.manage"], []);
    const grant = (allow: string[]) =>
      mia.client.put(`${V}/permissions`, { subjectType: "account", subjectId: mia.id, allow });
    expect((await grant(["history.restore"])).status).toBe(403); // she does not hold it
    expect((await grant(["note.write"])).status).toBe(200);
  });

  it("applies server-level grants and denies, and records them", async () => {
    const { root, mia } = await world();
    const role = store().roles.create({ name: "Maker", position: 1 });
    store().grantRole(role.id, mia.id);
    const put = (body: unknown) => root.client.put("/api/admin/permissions", body);
    expect(
      (await put({ subjectType: "role", subjectId: role.id, allow: ["vaults.create"] })).status,
    ).toBe(200);
    expect((await mia.client.post("/api/vaults", { id: "made" })).status).toBe(201);
    expect(
      (await put({ subjectType: "account", subjectId: mia.id, deny: ["vaults.create"] })).status,
    ).toBe(200);
    expect((await mia.client.post("/api/vaults", { id: "made2" })).status).toBe(403);
    expect(
      (await put({ subjectType: "role", subjectId: role.id, allow: ["note.read"] })).status,
    ).toBe(400);
    expect(
      (await root.client.del(`/api/admin/permissions?subjectType=account&subjectId=${mia.id}`))
        .status,
    ).toBe(204);
    expect(
      store()
        .audit.query({})
        .map((e) => e.action),
    ).toContain("permission.server_set");
  });

  it("reports what the caller may do", async () => {
    const { root, mia } = await world();
    setOverride("v", { type: "account", id: mia.id }, [], ["note.write"], "locked");
    const mine = await json<{ server: string[]; vault: string[] }>(
      await mia.client.get("/api/me/permissions?vault=v"),
    );
    expect(mine.server).toEqual([]);
    expect(mine.vault).toContain("note.write");
    const inLocked = await json<{ vault: string[] }>(
      await mia.client.get("/api/me/permissions?vault=v&folder=locked"),
    );
    expect(inLocked.vault).not.toContain("note.write");
    expect(inLocked.vault).toContain("note.read");
    const admin = await json<{ server: string[] }>(await root.client.get("/api/me/permissions"));
    expect(admin.server).toContain("server.manage");
  });
});

describe("no way back to a right that was taken away", () => {
  it("does not let someone lift their own denial by replacing or deleting the override", async () => {
    const { mia } = await world();
    setOverride("v", { type: "account", id: mia.id }, ["permissions.manage"], ["note.delete"]);
    const own = { subjectType: "account", subjectId: mia.id };
    expect(
      (await mia.client.put(`${V}/permissions`, { ...own, allow: ["permissions.manage"] })).status,
    ).toBe(403);
    expect(
      (await mia.client.del(`${V}/permissions?subjectType=account&subjectId=${mia.id}`)).status,
    ).toBe(403);
    expect((await mia.client.del(`${V}/files/b.md`)).status).toBe(403);
    // Tightening further is fine.
    expect(
      (
        await mia.client.put(`${V}/permissions`, {
          ...own,
          allow: ["permissions.manage"],
          deny: ["note.delete", "note.write"],
        })
      ).status,
    ).toBe(200);
  });

  it("does the same for server-level overrides", async () => {
    const { root, mia } = await world();
    const role = store().roles.create({
      name: "RM",
      position: 5,
      permissions: maskOf(["roles.manage", "server.manage"]),
    });
    store().grantRole(role.id, mia.id);
    setOverride(null, { type: "account", id: mia.id }, [], ["server.manage"]);
    expect((await mia.client.get("/api/removed-vaults")).status).toBe(403);
    expect(
      (
        await mia.client.put("/api/admin/permissions", {
          subjectType: "account",
          subjectId: mia.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (await mia.client.del(`/api/admin/permissions?subjectType=account&subjectId=${mia.id}`))
        .status,
    ).toBe(403);
    expect((await root.client.get("/api/removed-vaults")).status).toBe(200);
  });

  it("does not let a manager hand out a role holding permissions they lack", async () => {
    const { mia } = await world();
    const mod = store().roles.create({
      name: "Mod",
      position: 5,
      permissions: maskOf(["roles.manage", "users.manage"]),
    });
    const strong = store().roles.create({
      name: "Strong",
      position: 2,
      permissions: maskOf(["server.manage"]),
    });
    store().grantRole(mod.id, mia.id);
    expect((await mia.client.put(`/api/admin/users/${mia.id}/roles/${strong.id}`)).status).toBe(
      403,
    );
    expect((await mia.client.post("/api/admin/invites", { roleIds: [strong.id] })).status).toBe(
      403,
    );
    const weak = store().roles.create({
      name: "Weak",
      position: 2,
      permissions: maskOf(["users.manage"]),
    });
    expect((await mia.client.put(`/api/admin/users/${mia.id}/roles/${weak.id}`)).status).toBe(204);
  });
});
