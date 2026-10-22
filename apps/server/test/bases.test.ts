import { symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;
let admin: Client;

beforeEach(async () => {
  server = await startTestServer();
  await server.auth.createAccount({ username: "root", password: PASSWORD, serverAdmin: true });
  admin = new Client(server);
  expect((await admin.login("root")).status).toBe(200);
  expect((await admin.post("/api/vaults", { id: "demo" })).status).toBe(201);
  await write("Tasks/a.md", "---\nstatus: open\ntags: [task]\n---\n# A\n");
  await write("Tasks/b.md", "---\nstatus: done\ntags: [task]\n---\n# B\n");
  await write("Notes/c.md", "no properties\n");
  await write(
    "Tasks.base",
    'filters:\n  and:\n    - file.inFolder("Tasks")\nviews:\n  - type: table\n    name: All\n    order: [file.name, status]\n',
  );
});
afterEach(() => server.dispose());

const write = (path: string, content: string) =>
  admin.put(`/api/vaults/demo/files/${path}`, { content });

interface QueryBody {
  code?: string;
  total: number;
  version?: string;
  rows: { path: string; cells: Record<string, unknown> }[];
  columns: { id: string }[];
  available: { properties: string[] };
}
const query = async (body: unknown, client = admin) => {
  const res = await client.post("/api/vaults/demo/bases/query", body);
  return { status: res.status, body: await json<QueryBody>(res) };
};

describe("base query", () => {
  it("runs a .base file and returns its version", async () => {
    const { status, body } = await query({ path: "Tasks.base" });
    expect(status).toBe(200);
    expect(body.rows.map((r) => r.path).sort()).toEqual(["Tasks/a.md", "Tasks/b.md"]);
    expect(body.columns.map((c) => c.id)).toEqual(["file.name", "status"]);
    expect(body.version).toEqual(expect.any(String));
    expect(body.available.properties).toContain("status");
  });

  it("runs inline YAML for a note, with `this` set", async () => {
    const source =
      "filters:\n  and:\n    - file.folder == this.file.folder\nviews:\n  - type: table\n    name: Here\n";
    const { body } = await query({ source, thisPath: "Tasks/a.md" });
    expect(body.rows.map((r) => r.path).sort()).toEqual(["Tasks/a.md", "Tasks/b.md"]);
    expect(body.version).toBeUndefined();
  });

  it("rejects bad requests", async () => {
    expect((await query({})).body.code).toBe("invalid_request");
    expect((await query({ path: "Tasks/a.md" })).body.code).toBe("invalid_request");
    expect((await query({ source: "views: [" })).body.code).toBe("invalid_request");
    expect((await query({ path: "../x.base" })).body.code).toBe("invalid_path");
    expect((await query({ path: "Missing.base" })).status).toBe(404);
  });

  it("shows guests only rows of public notes", async () => {
    await admin.put("/api/vaults/demo/public", { paths: ["Tasks/a.md", "Tasks.base"] });
    const { status, body } = await query({ path: "Tasks.base" }, new Client(server));
    expect(status).toBe(200);
    expect(body.rows.map((r) => r.path)).toEqual(["Tasks/a.md"]);
    const hidden = await query({ path: "Notes.base" }, new Client(server));
    expect(hidden.status).toBe(404);
  });

  it("does not follow a link from a public folder to a private base", async () => {
    await write("pub/readme.md", "public");
    await admin.put("/api/vaults/demo/public", { paths: ["pub"] });
    const dir = path.join(server.dataDir, "vaults", "demo");
    try {
      await symlink(path.join(dir, "Tasks.base"), path.join(dir, "pub", "alias.base"));
    } catch {
      return; // no permission to create links on this machine
    }
    expect((await query({ path: "pub/alias.base" }, new Client(server))).status).toBe(404);
    expect((await query({ path: "pub/alias.base" })).status).toBe(200);
  });

  it("gives guests nothing in a vault without public content", async () => {
    const { status } = await query({ path: "Tasks.base" }, new Client(server));
    expect(status).toBe(404);
  });
});

describe("base cell edits", () => {
  const set = (path: string, key: string, value: unknown, client = admin) =>
    client.post("/api/vaults/demo/bases/property", { path, key, value });

  it("changes one property and records who did it", async () => {
    const res = await set("Tasks/a.md", "status", "done");
    expect(res.status).toBe(200);
    const file = await json<{ content: string }>(
      await admin.get("/api/vaults/demo/files/Tasks/a.md"),
    );
    expect(file.content).toBe("---\nstatus: done\ntags: [task]\n---\n# A\n");
    const { body } = await query({ path: "Tasks.base" });
    expect(body.rows.find((r) => r.path === "Tasks/a.md")?.cells.status).toBe("done");
    const history = await json<{ commits: { author: { name: string } }[] }>(
      await admin.get("/api/vaults/demo/history?path=Tasks/a.md"),
    );
    expect(history.commits[0]?.author.name).toBe("root");
  });

  it("adds a property to a note without any and removes with null", async () => {
    expect((await set("Notes/c.md", "status", "open")).status).toBe(200);
    let file = await json<{ content: string }>(
      await admin.get("/api/vaults/demo/files/Notes/c.md"),
    );
    expect(file.content).toContain("status: open");
    expect((await set("Notes/c.md", "status", null)).status).toBe(200);
    file = await json<{ content: string }>(await admin.get("/api/vaults/demo/files/Notes/c.md"));
    expect(file.content).not.toContain("status");
  });

  it("keeps every change when cells of one note are edited at once", async () => {
    const keys = ["p1", "p2", "p3", "p4", "p5"];
    const results = await Promise.all(keys.map((k) => set("Tasks/a.md", k, k)));
    expect(results.map((r) => r.status)).toEqual(keys.map(() => 200));
    const file = await json<{ content: string }>(
      await admin.get("/api/vaults/demo/files/Tasks/a.md"),
    );
    for (const k of keys) expect(file.content).toContain(`${k}: ${k}`);
  });

  it("refuses non-notes, bad paths and readers", async () => {
    expect((await set("Tasks.base", "x", 1)).status).toBe(400);
    expect((await set("../a.md", "x", 1)).status).toBe(400);
    expect((await set("Tasks/a.md", "", 1)).status).toBe(400);
    const guest = new Client(server);
    expect((await set("Tasks/a.md", "x", 1, guest)).status).toBeGreaterThanOrEqual(401);
    const missing = await set("Nope.md", "x", 1);
    expect(missing.status).toBe(404);
  });
});
