import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});
afterEach(() => server.dispose());

async function signIn(name: string, serverAdmin = false, displayName?: string) {
  const account = await server.auth.createAccount({
    username: name,
    password: PASSWORD,
    serverAdmin,
    ...(displayName ? { displayName } : {}),
  });
  const client = new Client(server);
  expect((await client.login(name)).status).toBe(200);
  return { client, id: account.id };
}

/** An administrator, a vault `v`, and a designer role that may only write under `design/`. */
async function world() {
  const root = await signIn("root", true);
  expect((await root.client.post("/api/vaults", { id: "v" })).status).toBe(201);
  const role = await json<{ id: string }>(
    await root.client.post("/api/admin/roles", { name: "Designer", color: "#aa3366" }),
  );
  const dana = await signIn("dana", false, "Dana Lee");
  server.store.joinVault("v", dana.id, "member");
  expect((await root.client.put(`/api/admin/users/${dana.id}/roles/${role.id}`)).status).toBe(204);
  return { root, dana, role };
}

describe("role member list", () => {
  it("lists who holds a role and everyone for @everyone", async () => {
    const { root, role, dana } = await world();
    const members = await json<{ members: { id: string; username: string }[] }>(
      await root.client.get(`/api/admin/roles/${role.id}/members`),
    );
    expect(members.members.map((m) => m.id)).toEqual([dana.id]);
    const everyone = server.store.roles.create({
      name: "@everyone",
      position: 0,
      isEveryone: true,
    });
    const all = await json<{ members: unknown[] }>(
      await root.client.get(`/api/admin/roles/${everyone.id}/members`),
    );
    expect(all.members).toHaveLength(2);
  });

  it("needs roles.manage", async () => {
    const { role, dana } = await world();
    expect((await dana.client.get(`/api/admin/roles/${role.id}/members`)).status).toBe(403);
  });
});

describe("find people by name", () => {
  it("lets a vault administrator without users.manage search accounts", async () => {
    const { dana } = await world();
    const lead = await signIn("lead");
    server.store.joinVault("v", lead.id, "admin");
    expect((await dana.client.get("/api/vaults/v/people?q=lee")).status).toBe(403);
    const found = await json<{ people: { id: string; member: boolean; username: string }[] }>(
      await lead.client.get("/api/vaults/v/people?q=LEE"),
    );
    expect(found.people).toEqual([
      { id: dana.id, username: "dana", displayName: "Dana Lee", member: true },
    ]);
    const none = await json<{ people: unknown[] }>(
      await lead.client.get("/api/vaults/v/people?q=nobody"),
    );
    expect(none.people).toEqual([]);
  });

  it("leaves out disabled accounts", async () => {
    const { root, dana } = await world();
    server.store.accounts.update(dana.id, { disabled: true });
    const found = await json<{ people: unknown[] }>(
      await root.client.get("/api/vaults/v/people?q=dana"),
    );
    expect(found.people).toEqual([]);
  });
});

describe("permission preview", () => {
  it("shows what a role may do in a folder and follows the overrides", async () => {
    const { root, dana, role } = await world();
    const put = (body: unknown) => root.client.put("/api/vaults/v/permissions", body);
    // Designers cannot write anywhere in the vault, except below design/.
    expect(
      (
        await put({
          subjectType: "role",
          subjectId: role.id,
          deny: ["note.write", "note.delete", "file.upload"],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put({
          folder: "design",
          subjectType: "role",
          subjectId: role.id,
          allow: ["note.write"],
        })
      ).status,
    ).toBe(200);

    const preview = async (query: string) =>
      (
        await json<{ permissions: string[] }>(
          await root.client.get(`/api/vaults/v/permissions/preview?${query}`),
        )
      ).permissions;

    const elsewhere = await preview(`roleId=${role.id}`);
    expect(elsewhere).toContain("note.read");
    expect(elsewhere).not.toContain("note.write");
    const inDesign = await preview(`roleId=${role.id}&folder=design`);
    expect(inDesign).toContain("note.write");
    expect(inDesign).not.toContain("note.delete");
    const person = await preview(`accountId=${dana.id}&folder=design/sub`);
    expect(person).toContain("note.write");
    expect(await preview(`accountId=${dana.id}&folder=other`)).not.toContain("note.write");
  });

  it("needs exactly one subject and permissions.manage", async () => {
    const { root, dana, role } = await world();
    expect((await root.client.get("/api/vaults/v/permissions/preview")).status).toBe(400);
    expect(
      (
        await root.client.get(
          `/api/vaults/v/permissions/preview?roleId=${role.id}&accountId=${dana.id}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await dana.client.get(`/api/vaults/v/permissions/preview?roleId=${role.id}`)).status,
    ).toBe(403);
  });
});

describe("roster", () => {
  it("gives every viewer the vault's people with their role colours", async () => {
    const { dana } = await world();
    const roster = await json<{
      people: { authorId: string; name: string; roles: { name: string; color?: string }[] }[];
    }>(await dana.client.get("/api/vaults/v/roster"));
    expect(roster.people.find((p) => p.authorId === "root")?.roles).toEqual([]);
    expect(roster.people.find((p) => p.authorId === "dana")).toEqual(
      expect.objectContaining({
        name: "Dana Lee",
        roles: [expect.objectContaining({ name: "Designer", color: "#aa3366" })],
      }),
    );
  });

  it("is not shown to people outside the vault", async () => {
    await world();
    const stranger = await signIn("stranger");
    expect((await stranger.client.get("/api/vaults/v/roster")).status).toBe(404);
  });
});

describe("a role that may only write in one folder", () => {
  it("is denied in the vault and allowed in the folder", async () => {
    const { root, dana, role } = await world();
    const put = (body: unknown) => root.client.put("/api/vaults/v/permissions", body);
    await put({
      subjectType: "role",
      subjectId: role.id,
      deny: ["note.write", "note.delete", "file.upload"],
    });
    await put({ folder: "design", subjectType: "role", subjectId: role.id, allow: ["note.write"] });

    const write = (path: string) =>
      dana.client.put(`/api/vaults/v/files/${path}`, { content: "x" }).then((r) => r.status);
    expect(await write("design/a.md")).toBe(200);
    expect(await write("design/deep/b.md")).toBe(200);
    expect(await write("other/a.md")).toBe(403);
    expect(await write("root.md")).toBe(403);
    // Only writing was allowed there.
    expect((await dana.client.del("/api/vaults/v/files/design/a.md")).status).toBe(403);
    // Reading is untouched, and a batch is checked path by path.
    expect((await dana.client.get("/api/vaults/v/files/design/a.md")).status).toBe(200);
    const batch = (path: string) =>
      dana.client
        .post("/api/vaults/v/batch", { writes: [{ path, baseVersion: null, content: "x" }] })
        .then((r) => r.status);
    expect(await batch("design/c.md")).toBe(200);
    expect(await batch("other/c.md")).toBe(403);
  });
});
