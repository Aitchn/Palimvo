import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOLS_LIST_BUDGET_BYTES } from "../src/mcp/server.ts";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

const NATIVE = [
  "list_vaults",
  "list_files",
  "read_note",
  "search",
  "get_backlinks",
  "create_note",
  "update_note",
  "move_note",
  "delete_note",
  "set_note_property",
  "read_canvas",
  "edit_canvas",
  "get_history",
  "get_diff",
  "upload_file",
  "download_file",
  "query_base",
  "list_tools",
  "describe_tool",
  "call_tool",
];

beforeEach(async () => {
  server = await startTestServer(
    { publicUrl: "https://palimvo.test" },
    {
      mcp: { plugins: { enabled: (v) => (v === "a" ? [{ id: "kanban", version: "1.0.0" }] : []) } },
    },
  );
});
afterEach(() => server.dispose());

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

async function makeToken(who: { client: Client }, body: Record<string, unknown>): Promise<string> {
  const res = await who.client.post("/api/tokens", body);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await json<{ secret: string }>(res)).secret;
}

async function world() {
  const root = await signIn("root", true);
  for (const v of ["a", "b"])
    expect((await root.client.post("/api/vaults", { id: v })).status).toBe(201);
  const mia = await signIn("mia");
  server.store.joinVault("a", mia.id, "member");
  server.store.joinVault("b", mia.id, "member");
  return { root, mia };
}

async function connect(path: string, secret: string, headers: Record<string, string> = {}) {
  const client = new McpClient({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, server.url), {
      requestInit: { headers: { authorization: `Bearer ${secret}`, ...headers } },
    }),
  );
  return client;
}

type Result = { isError?: boolean; content: { type: string; text?: string }[] };
// Results are poked at freely; their shape is checked by the assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const body = (r: unknown): Json => JSON.parse((r as Result).content[0]!.text!) as Json;

/** A write-capable AI client on vault `a`, credited under `name`. */
async function ai(name: string, extra: Record<string, unknown> = {}) {
  const { mia } = await world.cached();
  const secret = await makeToken(mia, { name, access: "write", vaultId: "a", ...extra });
  const c = await connect("/mcp/a", secret, {
    "x-palimvo-author": `ai:${encodeURIComponent(name)}`,
  });
  const call = async (tool: string, args: Record<string, unknown> = {}) =>
    body(await c.callTool({ name: tool, arguments: args }));
  return { c, call };
}
const worldCache = { value: undefined as Awaited<ReturnType<typeof world>> | undefined };
world.cached = async () => (worldCache.value ??= await world());
beforeEach(() => {
  worldCache.value = undefined;
});

describe("tools/list", () => {
  it("offers about 20 native tools on /mcp and one fewer on /mcp/:vault, within the size budget", async () => {
    const { mia } = await world.cached();
    const secret = await makeToken(mia, { name: "x", access: "write" });
    const all = await connect("/mcp", secret);
    const listed = (await all.listTools()).tools;
    expect(listed.map((t) => t.name).sort()).toEqual([...NATIVE].sort());
    expect(JSON.stringify(listed).length).toBeLessThan(TOOLS_LIST_BUDGET_BYTES);
    const one = (await (await connect("/mcp/a", secret)).listTools()).tools;
    expect(one.map((t) => t.name)).not.toContain("list_vaults");
    expect(one).toHaveLength(NATIVE.length - 1);
    expect(JSON.stringify(one).length).toBeLessThan(TOOLS_LIST_BUDGET_BYTES);
  });

  it("a read-only token sees no write tools", async () => {
    const { mia } = await world.cached();
    const c = await connect("/mcp", await makeToken(mia, { name: "r", access: "read" }));
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const w of [
      "create_note",
      "update_note",
      "move_note",
      "delete_note",
      "edit_canvas",
      "upload_file",
    ])
      expect(names).not.toContain(w);
    expect(names).toEqual(
      expect.arrayContaining(["read_note", "search", "query_base", "get_diff"]),
    );
  });
});

describe("list_vaults", () => {
  it("shows the plugins enabled in each vault", async () => {
    const { mia } = await world.cached();
    const c = await connect("/mcp", await makeToken(mia, { name: "x", access: "write" }));
    expect(body(await c.callTool({ name: "list_vaults", arguments: {} })).vaults).toEqual([
      { id: "a", access: "write", plugins: [{ id: "kanban", version: "1.0.0" }] },
      { id: "b", access: "write" },
    ]);
  });
});

describe("notes", () => {
  it("creates, reads, lists, edits, moves and deletes", async () => {
    const { call } = await ai("Claude Code");
    const made = await call("create_note", {
      path: "Projects/Plan",
      content: "# Plan\n\n- TODO ship\n",
      reason: "start the plan",
    });
    expect(made.path).toBe("Projects/Plan.md");
    expect(
      (await call("create_note", { path: "Projects/Plan.md", reason: "again" })).error.code,
    ).toBe("already_exists");

    const read = await call("read_note", { path: "Projects/Plan.md" });
    expect(read).toMatchObject({ kind: "markdown", content: "# Plan\n\n- TODO ship\n" });
    expect(read.version).toBe(made.version);

    expect(
      await call("update_note", {
        path: "Projects/Plan.md",
        edits: [{ find: "TODO", replace: "DONE" }],
        append: "- next",
        reason: "progress",
      }),
    ).toMatchObject({ changed: true });
    expect((await call("read_note", { path: "Projects/Plan.md" })).content).toBe(
      "# Plan\n\n- DONE ship\n- next",
    );

    const root = await call("list_files", {});
    expect(root.entries).toEqual(expect.arrayContaining([{ path: "Projects", type: "folder" }]));
    expect((await call("list_files", { folder: "Projects" })).entries).toEqual([
      { path: "Projects/Plan.md", type: "file", kind: "markdown" },
    ]);
    expect((await call("list_files", { recursive: true })).files).toContain("Projects/Plan.md");
    expect((await call("list_files", { folder: "Nope" })).error.code).toBe("not_found");

    await call("move_note", { from: "Projects/Plan.md", to: "Done/Plan.md", reason: "archive" });
    expect((await call("read_note", { path: "Projects/Plan.md" })).error.code).toBe("not_found");
    expect((await call("read_note", { path: "Done/Plan.md" })).content).toContain("DONE");

    expect(await call("delete_note", { path: "Done/Plan.md", reason: "cleanup" })).toMatchObject({
      deleted: true,
    });
    expect((await call("read_note", { path: "Done/Plan.md" })).error.code).toBe("not_found");
  });

  it("applies edits all or none and explains why one failed", async () => {
    const { call } = await ai("Claude Code");
    await call("create_note", { path: "a.md", content: "x x y", reason: "r" });
    const twice = await call("update_note", {
      path: "a.md",
      edits: [{ find: "x", replace: "z" }],
      reason: "r",
    });
    expect(twice.error.message).toContain("2 times");
    const missing = await call("update_note", {
      path: "a.md",
      edits: [
        { find: "y", replace: "Y" },
        { find: "nope", replace: "!" },
      ],
      reason: "r",
    });
    expect(missing.error.details).toEqual({ index: 1 });
    expect((await call("read_note", { path: "a.md" })).content).toBe("x x y");
    await call("update_note", {
      path: "a.md",
      edits: [{ find: "x", replace: "z", all: true }],
      reason: "r",
    });
    expect((await call("read_note", { path: "a.md" })).content).toBe("z z y");
    expect((await call("update_note", { path: "a.md", reason: "r" })).error.code).toBe(
      "invalid_request",
    );
  });

  it("sets and removes properties", async () => {
    const { call } = await ai("Claude Code");
    await call("create_note", {
      path: "t.md",
      content: "---\nstatus: open\n---\nBody\n",
      reason: "r",
    });
    await call("set_note_property", { path: "t.md", key: "status", value: "done", reason: "r" });
    await call("set_note_property", { path: "t.md", key: "tags", value: ["a", "b"], reason: "r" });
    const note = await call("read_note", { path: "t.md" });
    expect(note.properties).toEqual({ status: "done", tags: ["a", "b"] });
    expect(note.content).toContain("Body");
    await call("set_note_property", { path: "t.md", key: "status", value: null, reason: "r" });
    expect((await call("read_note", { path: "t.md" })).properties).toEqual({ tags: ["a", "b"] });
  });

  it("searches and finds backlinks", async () => {
    const { call } = await ai("Claude Code");
    await call("create_note", { path: "Rocket.md", content: "A rocket plan", reason: "r" });
    await call("create_note", { path: "Index.md", content: "See [[Rocket]]\n", reason: "r" });
    const found = await call("search", { query: "rocket" });
    expect(found.hits.map((h: Json) => h.path).sort()).toEqual(["Index.md", "Rocket.md"].sort());
    const back = await call("get_backlinks", { path: "Rocket.md" });
    expect(back.backlinks).toEqual([
      { path: "Index.md", lines: [{ line: 1, text: "See [[Rocket]]" }] },
    ]);
  });

  it("refuses bad paths and binary reads as results", async () => {
    const { call } = await ai("Claude Code");
    expect((await call("read_note", { path: "../x.md" })).error.code).toBe("invalid_path");
    await call("upload_file", { path: "img.png", content_base64: "iVBORw0KGgo=", reason: "r" });
    expect((await call("read_note", { path: "img.png" })).error.code).toBe("unsupported_type");
  });
});

describe("canvas", () => {
  it("adds nodes and edges in one call and changes them later", async () => {
    const { call } = await ai("Claude Code");
    await call("create_note", { path: "Map.canvas", reason: "new canvas" });
    await call("create_note", { path: "Plan.md", content: "x", reason: "r" });
    const res = await call("edit_canvas", {
      path: "Map.canvas",
      reason: "sketch",
      operations: [
        { op: "add_node", type: "text", id: "idea", text: "Idea" },
        { op: "add_node", type: "file", id: "plan", file: "Plan.md" },
        { op: "add_edge", from: "idea", to: "plan", label: "see" },
      ],
    });
    expect(res.added.map((a: Json) => a.id)).toEqual(["idea", "plan", expect.any(String)]);
    expect(res).toMatchObject({ nodes: 2, edges: 1 });
    const canvas = await call("read_canvas", { path: "Map.canvas" });
    const [idea, plan] = canvas.nodes;
    expect(idea.id).toBe("idea");
    // Nodes without a position are stacked, not piled on top of each other.
    expect(plan.y).toBeGreaterThanOrEqual(idea.y + idea.height);
    expect(canvas.edges[0]).toMatchObject({ fromNode: "idea", toNode: "plan", label: "see" });

    await call("edit_canvas", {
      path: "Map.canvas",
      reason: "tweak",
      operations: [
        { op: "update_node", id: "idea", text: "Better idea", color: "4" },
        { op: "update_edge", id: canvas.edges[0].id, label: null },
      ],
    });
    const after = await call("read_canvas", { path: "Map.canvas" });
    expect(after.nodes[0]).toMatchObject({ text: "Better idea", color: "4" });
    expect(after.edges[0].label).toBeUndefined();

    await call("edit_canvas", {
      path: "Map.canvas",
      reason: "prune",
      operations: [{ op: "remove", ids: ["idea"] }],
    });
    const left = await call("read_canvas", { path: "Map.canvas" });
    expect(left.nodes.map((n: Json) => n.id)).toEqual(["plan"]);
    expect(left.edges).toEqual([]);
  });

  it("changes nothing when one operation is wrong", async () => {
    const { call } = await ai("Claude Code");
    await call("create_note", { path: "Map.canvas", reason: "r" });
    const bad = await call("edit_canvas", {
      path: "Map.canvas",
      reason: "r",
      operations: [
        { op: "add_node", type: "text", id: "a", text: "A" },
        { op: "add_edge", from: "a", to: "ghost" },
      ],
    });
    expect(bad.error.code).toBe("invalid_request");
    expect(bad.error.message).toContain("operations[1]");
    expect((await call("read_canvas", { path: "Map.canvas" })).nodes).toEqual([]);
    expect(
      (
        await call("edit_canvas", {
          path: "Plan.md",
          reason: "r",
          operations: [{ op: "remove", ids: ["x"] }],
        })
      ).error.code,
    ).toBe("invalid_request");
  });
});

describe("databases", () => {
  it("queries a base over note properties", async () => {
    const { call } = await ai("Claude Code");
    await call("create_note", {
      path: "Tasks.base",
      content:
        "filters:\n  and:\n    - 'status == \"open\"'\nviews:\n  - type: table\n    name: Open\n    order:\n      - file.name\n      - status\n",
      reason: "r",
    });
    await call("create_note", { path: "T1.md", content: "---\nstatus: open\n---\n", reason: "r" });
    await call("create_note", { path: "T2.md", content: "---\nstatus: done\n---\n", reason: "r" });
    const res = await call("query_base", { path: "Tasks.base" });
    expect(res.total).toBe(1);
    expect(res.rows[0].path).toBe("T1.md");
    expect(res.columns.map((c: Json) => c.id)).toEqual(["file.name", "status"]);
    // Changing a property changes the result.
    await call("set_note_property", { path: "T2.md", key: "status", value: "open", reason: "r" });
    expect((await call("query_base", { path: "Tasks.base" })).total).toBe(2);
    expect((await call("query_base", { path: "T1.md" })).error.code).toBe("invalid_request");
  });
});

describe("history", () => {
  it("lists changes with their authors and reasons, and shows a diff", async () => {
    const { call } = await ai("Claude Code");
    await call("create_note", { path: "h.md", content: "one\n", reason: "first draft" });
    await call("update_note", { path: "h.md", append: "two", reason: "second line" });
    const history = await call("get_history", { path: "h.md" });
    expect(history.commits.length).toBeGreaterThan(0);
    const newest = history.commits[0];
    expect(newest.author).toEqual({ name: "Claude Code", kind: "ai" });
    expect(JSON.stringify(history.commits)).toContain("second line");
    expect(newest.files).toEqual(["h.md"]);
    const diff = await call("get_diff", { commit: newest.id, path: "h.md" });
    expect(diff.diff).toContain("+two");
    expect((await call("get_diff", { commit: "deadbeefdead" })).error.code).toBe("not_found");
  });
});

describe("files", () => {
  it("uploads and downloads bytes, and protects existing files", async () => {
    const { call, c } = await ai("Claude Code");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const up = await call("upload_file", {
      path: "assets/logo.png",
      content_base64: png.toString("base64"),
      reason: "add logo",
    });
    expect(up).toMatchObject({ path: "assets/logo.png", size: png.length });
    expect(
      (await call("upload_file", { path: "assets/logo.png", content_base64: "AAAA", reason: "r" }))
        .error.code,
    ).toBe("already_exists");
    expect(
      (
        await call("upload_file", {
          path: "assets/logo.png",
          content_base64: "AAAA",
          overwrite: true,
          reason: "r",
        })
      ).size,
    ).toBe(3);
    const raw = (await c.callTool({
      name: "download_file",
      arguments: { path: "assets/logo.png" },
    })) as Result;
    expect(body(raw)).toMatchObject({ mime: "image/png", size: 3 });
    expect(raw.content[1]).toMatchObject({ type: "image", data: "AAAA", mimeType: "image/png" });
    await call("upload_file", { path: "doc.pdf", content_base64: "AAAA", reason: "r" });
    expect(await call("download_file", { path: "doc.pdf" })).toMatchObject({
      mime: "application/pdf",
      content_base64: "AAAA",
    });
    expect((await call("download_file", { path: "assets/none.png" })).error.code).toBe("not_found");
  });

  it("returns small images as image content", async () => {
    const { call, c } = await ai("Claude Code");
    await call("upload_file", { path: "p.png", content_base64: "iVBORw0KGgo=", reason: "r" });
    const res = (await c.callTool({
      name: "download_file",
      arguments: { path: "p.png" },
    })) as Result;
    expect(res.content.map((p) => p.type)).toEqual(["text", "image"]);
  });

  it("rejects invalid base64, notes, and unknown types", async () => {
    const { call } = await ai("Claude Code");
    expect(
      (await call("upload_file", { path: "x.png", content_base64: "***", reason: "r" })).error.code,
    ).toBe("invalid_request");
    expect(
      (await call("upload_file", { path: "x.md", content_base64: "AAAA", reason: "r" })).error.code,
    ).toBe("invalid_request");
    expect(
      (await call("upload_file", { path: "x.png", content_base64: "A==", reason: "r" })).error.code,
    ).toBe("invalid_request");
    expect(
      (await call("upload_file", { path: "x.weird", content_base64: "AAAA", reason: "r" })).error
        .code,
    ).toBe("unsupported_type");
  });
});

describe("permissions", () => {
  it("a propose-only token is told to propose", async () => {
    const { mia } = await world.cached();
    const c = await connect("/mcp", await makeToken(mia, { name: "p", access: "propose" }));
    const r = body(
      await c.callTool({
        name: "create_note",
        arguments: { vault: "a", path: "x.md", content: "x", reason: "r" },
      }),
    );
    expect(r.error.code).toBe("propose_only");
  });

  it("a folder-limited token reads and writes only inside its folders", async () => {
    const { call: full } = await ai("Full");
    await full("create_note", {
      path: "design/brief.md",
      content: "design brief rocket",
      reason: "r",
    });
    await full("create_note", { path: "secret/plan.md", content: "secret rocket", reason: "r" });
    await full("create_note", { path: "design/link.md", content: "[[plan]]", reason: "r" });
    const { call } = await ai("Designer", { folders: ["design"] });
    expect((await call("read_note", { path: "design/brief.md" })).content).toContain("brief");
    expect((await call("read_note", { path: "secret/plan.md" })).error.code).toBe(
      "token_scope_denied",
    );
    expect(
      (await call("create_note", { path: "secret/x.md", content: "x", reason: "r" })).error.code,
    ).toBe("token_scope_denied");
    expect(
      (await call("update_note", { path: "design/brief.md", append: "ok", reason: "r" })).changed,
    ).toBe(true);
    expect((await call("search", { query: "rocket" })).hits.map((h: Json) => h.path)).toEqual([
      "design/brief.md",
    ]);
    expect((await call("list_files", { recursive: true })).files.sort()).toEqual([
      "design/brief.md",
      "design/link.md",
    ]);
    expect((await call("list_files", {})).entries).toEqual([{ path: "design", type: "folder" }]);
    expect((await call("get_diff", { commit: "abcdef123456" })).error.code).toBe("invalid_request");
    const history = await call("get_history", {});
    expect(JSON.stringify(history)).not.toContain("secret");
  });

  it("pages through listings", async () => {
    const { call } = await ai("Claude Code");
    for (const n of ["a", "b", "c"]) await call("create_note", { path: `${n}.md`, reason: "r" });
    const first = await call("list_files", { recursive: true, limit: 2 });
    expect(first.next_offset).toBe(2);
    const rest = await call("list_files", { recursive: true, limit: 2, offset: first.next_offset });
    expect(rest.next_offset).toBeUndefined();
    expect([...first.files, ...rest.files].sort()).toEqual(
      ["Welcome.md", "a.md", "b.md", "c.md"].sort(),
    );
  });

  it("hides what a mixed change says about files outside the token's folders", async () => {
    const { call: full } = await ai("Full");
    await full("create_note", { path: "design/a.md", reason: "r" });
    await full("create_note", { path: "secret/b.md", reason: "r" });
    const { call } = await ai("Designer", { folders: ["design"] });
    const commits = (await call("get_history", {})).commits as Json[];
    expect(JSON.stringify(commits)).not.toContain("secret");
  });

  it("a member without write permission cannot change notes", async () => {
    const { mia } = await world.cached();
    const secret = await makeToken(mia, { name: "r", access: "read", vaultId: "a" });
    const c = await connect("/mcp/a", secret);
    const r = body(
      await c.callTool({ name: "delete_note", arguments: { path: "Welcome.md", reason: "r" } }),
    );
    expect(["token_scope_denied", "forbidden"]).toContain(r.error.code);
  });
});

describe("three AI clients tidying one vault at once", () => {
  it("keeps every change and credits each client", async () => {
    await world.cached();
    const [x, y, z] = await Promise.all([ai("Claude Code"), ai("Cursor"), ai("ChatGPT")]);
    await x.call("create_note", {
      path: "Shared.md",
      content: "# Shared\n\nline\n",
      reason: "seed",
    });
    await x.call("create_note", { path: "Board.canvas", reason: "seed canvas" });

    const jobs: Promise<Json>[] = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(x.call("update_note", { path: "Shared.md", append: `- x${i}`, reason: `x ${i}` }));
      jobs.push(y.call("update_note", { path: "Shared.md", append: `- y${i}`, reason: `y ${i}` }));
      jobs.push(
        z.call("set_note_property", {
          path: "Shared.md",
          key: `p${i}`,
          value: i,
          reason: `p ${i}`,
        }),
      );
      jobs.push(
        y.call("edit_canvas", {
          path: "Board.canvas",
          reason: `node ${i}`,
          operations: [{ op: "add_node", type: "text", text: `n${i}` }],
        }),
      );
      jobs.push(
        z.call("create_note", { path: `Notes/z${i}.md`, content: `z${i}`, reason: `z ${i}` }),
      );
    }
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r.error)).toEqual([]);

    const note = await x.call("read_note", { path: "Shared.md" });
    for (let i = 0; i < 5; i++) {
      expect(note.content).toContain(`- x${i}`);
      expect(note.content).toContain(`- y${i}`);
      expect(note.properties[`p${i}`]).toBe(i);
    }
    expect((await x.call("read_canvas", { path: "Board.canvas" })).nodes).toHaveLength(5);
    expect((await x.call("list_files", { folder: "Notes" })).entries).toHaveLength(5);

    // A commit has one author and credits everyone else who changed its files as co-authors.
    const authors = new Set<string>();
    for (const c of (await x.call("get_history", { limit: 100 })).commits as Json[]) {
      authors.add(c.author.name);
      for (const name of c.co_authors ?? []) authors.add(name);
    }
    expect([...authors]).toEqual(expect.arrayContaining(["Claude Code", "Cursor", "ChatGPT"]));
  });
});
