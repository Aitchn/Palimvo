import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asRequestFiles, file } from "../src/plugins/testing.ts";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;
beforeEach(async () => {
  server = await startTestServer(
    { publicUrl: "https://palimvo.test" },
    { sandbox: { limits: { timeoutMs: 600 } } },
  );
});
afterEach(() => server.dispose());

// Results are poked at freely; their shape is checked by the assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Result = { isError?: boolean; content: { type: string; text?: string }[] };
const body = (r: unknown): Json => JSON.parse((r as Result).content[0]!.text!) as Json;

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

async function makeToken(who: { client: Client }, input: Record<string, unknown>) {
  const res = await who.client.post("/api/tokens", input);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await json<{ secret: string }>(res)).secret;
}

const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS = [
  {
    name: "summarize",
    readOnly: true,
    inputSchema: schema({ folder: { type: "string" } }, ["folder"]),
  },
  { name: "save", inputSchema: schema({ title: { type: "string", minLength: 1 } }, ["title"]) },
  { name: "escape", inputSchema: schema() },
  { name: "peek", readOnly: true, inputSchema: schema() },
  { name: "propose", inputSchema: schema({ text: { type: "string" } }, ["text"]) },
  { name: "spin", readOnly: true, inputSchema: schema() },
  { name: "bomb", readOnly: true, inputSchema: schema() },
  { name: "hang", readOnly: true, inputSchema: schema() },
  { name: "flood", readOnly: true, inputSchema: schema() },
  { name: "boom", readOnly: true, inputSchema: schema() },
].map((t) => ({ ...t, description: `The ${t.name} tool.` }));

const SERVER_JS = `
globalThis.__plugin = { tools: {
  summarize: async ({ folder }) => {
    const files = await vault.list({ dir: folder });
    console.log("listed", files.length);
    return { files, first: files.length ? await vault.read({ path: files[0] }) : null };
  },
  save: async ({ title }) => vault.write({ path: "decisions/" + title + ".md", content: "# " + title }),
  escape: async () => {
    try { await vault.write({ path: "private/x.md", content: "x" }); return "wrote"; }
    catch (e) { return "denied: " + e.message; }
  },
  peek: async () => {
    try { return await vault.read({ path: "private/secret.md" }); }
    catch (e) { return "denied: " + e.message; }
  },
  propose: async ({ text }) => vault.propose({ path: "decisions/p.md", content: text, title: "From plugin" }),
  spin: async () => { for (;;) {} },
  bomb: async () => { const a = []; for (;;) a.push(new Array(10000).fill("x".repeat(100))); },
  hang: async () => new Promise(() => {}),
  flood: async () => { for (let i = 0; i < 1000; i++) await vault.list({}); },
  boom: async () => { throw new TypeError("nope"); },
} };
`;

function pluginFiles(serverJs = SERVER_JS, manifest: Record<string, unknown> = {}) {
  return [
    file(
      "manifest.json",
      JSON.stringify({
        manifestVersion: 2,
        id: "decider",
        version: "1.0.0",
        name: { en: "Decider" },
        permissions: { read: ["notes", "decisions"], write: ["decisions"], network: false },
        contributes: { tools: TOOLS },
        main: "main.js",
        server: "server.js",
        ...manifest,
      }),
    ),
    file("main.js", "export default () => {};"),
    file("server.js", serverJs),
  ];
}

/** Admin `root` owns vault `a`; `mia` is a member; `b` is a second vault where the plugin is not installed. */
async function world() {
  const root = await signIn("root", true);
  for (const v of ["a", "b"])
    expect((await root.client.post("/api/vaults", { id: v })).status).toBe(201);
  const mia = await signIn("mia");
  server.store.joinVault("a", mia.id, "member");
  server.store.joinVault("b", mia.id, "member");
  const { vaults } = server.services;
  await vaults.writeFile("a", "notes/one.md", "hello from notes");
  await vaults.writeFile("a", "private/secret.md", "top secret");
  return { root, mia };
}

async function install(root: { client: Client }, files = pluginFiles(), { approve = true } = {}) {
  const added = await json<Json>(
    await root.client.post("/api/vaults/a/plugins", { files: asRequestFiles(files) }),
  );
  expect(added.id, JSON.stringify(added)).toBe("decider");
  if (approve) {
    expect(
      (await root.client.patch("/api/vaults/a/plugins/decider", { enabled: true })).status,
    ).toBe(200);
    const res = await root.client.post("/api/vaults/a/plugins/decider/approve", {
      sha256: added.sha256,
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  }
  return added;
}

async function connect(path: string, secret: string, author?: string) {
  const client = new McpClient({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, server.url), {
      requestInit: {
        headers: {
          authorization: `Bearer ${secret}`,
          ...(author ? { "x-palimvo-author": `ai:${encodeURIComponent(author)}` } : {}),
        },
      },
    }),
  );
  const call = async (tool: string, args: Record<string, unknown> = {}) =>
    body(await client.callTool({ name: tool, arguments: args }));
  return {
    client,
    call,
    /** Runs a plugin tool through the entry tool. */
    plugin: (name: string, args: Record<string, unknown> = {}, reason = "test") =>
      call("call_tool", { name: `decider.${name}`, arguments: { ...args, reason } }),
  };
}

/** A write AI client on vault `a` working for mia. */
async function ai(
  mia: { client: Client },
  access: "read" | "propose" | "write" = "write",
  name = "Claude",
) {
  return connect("/mcp/a", await makeToken(mia, { name, access, vaultId: "a" }), name);
}

describe("availability", () => {
  it("offers a plugin's tools only while it is installed, on, approved, and only in that vault", async () => {
    const { root, mia } = await world();
    const a = await ai(mia);
    expect((await a.call("list_tools")).tools.map((t: Json) => t.name)).not.toContain(
      "decider.summarize",
    );
    await install(root, pluginFiles(), { approve: false });
    // Installed but off and unapproved.
    expect(JSON.stringify(await a.call("list_tools"))).not.toContain("decider.");
    expect((await a.plugin("summarize", { folder: "notes" })).error.code).toBe("not_found");

    await root.client.patch("/api/vaults/a/plugins/decider", { enabled: true });
    expect(JSON.stringify(await a.call("list_tools"))).not.toContain("decider.");
    const row = await json<Json>(await root.client.get("/api/vaults/a/plugins/decider"));
    await root.client.post("/api/vaults/a/plugins/decider/approve", { sha256: row.sha256 });

    const listed = await a.call("list_tools", { query: "decider." });
    expect(listed.tools.map((t: Json) => t.name).sort()).toEqual(
      TOOLS.map((t) => `decider.${t.name}`).sort(),
    );
    expect(listed.tools.find((t: Json) => t.name === "decider.save").writes).toBe(true);
    expect(listed.tools.find((t: Json) => t.name === "decider.summarize").writes).toBeUndefined();

    // The other vault never sees it, even on the all-vaults endpoint.
    const b = await connect(
      "/mcp/b",
      await makeToken(mia, { name: "B", access: "write", vaultId: "b" }),
    );
    expect(JSON.stringify(await b.call("list_tools"))).not.toContain("decider.");
    const all = await connect("/mcp", await makeToken(mia, { name: "All", access: "write" }));
    expect(JSON.stringify(await all.call("list_tools", { vault: "b" }))).not.toContain("decider.");
    expect(
      (await all.call("list_tools", { vault: "a", query: "summarize" })).tools.map(
        (t: Json) => t.name,
      ),
    ).toEqual(["decider.summarize"]);
    expect(
      (
        await all.call("call_tool", {
          name: "decider.summarize",
          vault: "b",
          arguments: { folder: "x" },
        })
      ).error.code,
    ).toBe("not_found");

    // Switching it off takes the tools away again.
    await root.client.patch("/api/vaults/a/plugins/decider", { enabled: false });
    expect(JSON.stringify(await a.call("list_tools"))).not.toContain("decider.");
  });

  it("shows the plugin's own schema in describe_tool, with vault and reason added", async () => {
    const { root, mia } = await world();
    await install(root);
    const all = await connect("/mcp", await makeToken(mia, { name: "All", access: "write" }));
    const d = await all.call("describe_tool", { name: "decider.save", vault: "a" });
    expect(d.writes).toBe(true);
    expect(d.arguments.properties).toHaveProperty("title");
    expect(d.arguments.properties).toHaveProperty("vault");
    expect(d.arguments.properties).toHaveProperty("reason");
    expect(d.arguments.required.sort()).toEqual(["reason", "title", "vault"]);
    const one = await ai(mia);
    const dOne = await one.call("describe_tool", { name: "decider.summarize" });
    expect(Object.keys(dOne.arguments.properties)).toEqual(["folder"]);
  });

  it("lists them in tools/list when the vault asks for it (vault admins only), and only on /mcp/<vault>", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia);
    const names = async (c: Awaited<ReturnType<typeof ai>>) =>
      (await c.client.listTools()).tools.map((t) => t.name);
    expect(await names(a)).not.toContain("decider.summarize");

    expect((await mia.client.put("/api/vaults/a/plugin-tools", { listed: true })).status).toBe(403);
    const res = await root.client.put("/api/vaults/a/plugin-tools", { listed: true });
    expect(res.status).toBe(200);
    expect(await json(await root.client.get("/api/vaults/a/plugin-tools"))).toEqual({
      listed: true,
    });

    const fresh = await ai(mia, "write", "Again");
    const listed = await fresh.client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain("decider.summarize");
    const save = listed.tools.find((t) => t.name === "decider.save")!;
    expect(save.annotations?.readOnlyHint).toBe(false);
    expect(Object.keys(save.inputSchema.properties ?? {}).sort()).toEqual(["reason", "title"]);
    // Directly callable, and still behind call_tool.
    const direct = body(
      await fresh.client.callTool({ name: "decider.summarize", arguments: { folder: "notes" } }),
    );
    expect(direct.result.files).toEqual(["notes/one.md"]);
    expect((await fresh.call("list_tools", { query: "decider.sum" })).tools).toHaveLength(1);
    // The all-vaults endpoint keeps tools/list short.
    const all = await connect("/mcp", await makeToken(mia, { name: "All", access: "write" }));
    expect((await all.client.listTools()).tools.map((t) => t.name)).not.toContain(
      "decider.summarize",
    );

    await root.client.put("/api/vaults/a/plugin-tools", { listed: false });
    expect(await names(await ai(mia, "write", "Third"))).not.toContain("decider.summarize");
  });
});

describe("running tools", () => {
  it("runs a tool in the sandbox, with host reads, list and debug logs", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia);
    const r = await a.plugin("summarize", { folder: "notes" }, "look");
    expect(r).toEqual({
      result: { files: ["notes/one.md"], first: "hello from notes" },
      logs: ["listed 1"],
    });
  });

  it("checks arguments against the manifest schema before any plugin code runs", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia);
    const missing = await a.plugin("summarize", {});
    expect(missing.error.code).toBe("invalid_request");
    expect(missing.error.message).toContain("folder");
    expect((await a.plugin("summarize", { folder: "notes", extra: 1 })).error.code).toBe(
      "invalid_request",
    );
    expect((await a.plugin("save", { title: "" })).error.code).toBe("invalid_request");
    // A write tool needs a reason like every write.
    expect(
      (await a.call("call_tool", { name: "decider.save", arguments: { title: "x" } })).error.code,
    ).toBe("invalid_request");
  });

  it("writes only inside the declared folders, as the plugin acting for the AI", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia, "write", "Claude");
    expect((await a.plugin("escape")).result).toMatch(/^denied: permission_denied/);
    expect((await json<Json>(await mia.client.get("/api/vaults/a/files/private/x.md"))).code).toBe(
      "not_found",
    );

    const saved = await a.plugin("save", { title: "use-sqlite" }, "Record the decision");
    expect(saved.result.path).toBe("decisions/use-sqlite.md");
    const file = await json<Json>(
      await mia.client.get("/api/vaults/a/files/decisions/use-sqlite.md"),
    );
    expect(file.content).toBe("# use-sqlite");

    const history = await a.call("get_history", { path: "decisions/use-sqlite.md" });
    expect(history.commits[0].author).toMatchObject({ kind: "plugin", name: "Decider" });
    expect(history.commits[0].co_authors ?? []).toEqual([]);
    expect(history.commits[0].reasons).toEqual(["Record the decision"]);
  });

  it("never reads beyond the manifest folders, and never beyond the caller's rights", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia);
    expect((await a.plugin("peek")).result).toMatch(/^denied: permission_denied/);
    // The manifest allows writing decisions/, but a read-only token may not write there.
    const reader = await ai(mia, "read", "Reader");
    const r = await reader.plugin("save", { title: "nope" });
    expect(r.error?.code ?? "").not.toBe("");
    expect((await mia.client.get("/api/vaults/a/files/decisions/nope.md")).status).toBe(404);
    // A token limited to a folder cannot be used to read outside it through the plugin.
    const limited = await connect(
      "/mcp/a",
      await makeToken(mia, { name: "L", access: "write", vaultId: "a", folders: ["notes"] }),
    );
    const list = await limited.plugin("summarize", { folder: "decisions" });
    expect(list.result?.files ?? []).toEqual([]);
  });

  it("turns vault.propose into an edit proposal credited to the plugin", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia, "write", "Claude");
    const r = await a.plugin("propose", { text: "# Proposed" });
    expect(r.result.state).toBe("pending");
    const proposal = await a.call("call_tool", {
      name: "get_edit_proposal",
      arguments: { id: r.result.id },
    });
    expect(proposal.title).toBe("From plugin");
    expect(JSON.stringify(proposal)).toContain("Decider");
    expect((await mia.client.get("/api/vaults/a/files/decisions/p.md")).status).toBe(404);
  });

  it("lets a propose-only caller use vault.propose but not vault.write", async () => {
    const { root, mia } = await world();
    await install(root);
    const p = await ai(mia, "propose", "Suggester");
    expect((await p.plugin("propose", { text: "# From proposer" })).result.state).toBe("pending");
    expect((await p.plugin("save", { title: "direct" })).error).toBeDefined();
    expect((await mia.client.get("/api/vaults/a/files/decisions/direct.md")).status).toBe(404);
  });

  it("keeps the backup and plugin-tool settings that share config.json", async () => {
    const { root } = await world();
    await Promise.all([
      root.client.put("/api/vaults/a/plugin-tools", { listed: true }),
      server.services.vaults.modifyMeta("a", "config.json", (t) =>
        JSON.stringify({ ...JSON.parse(t!), other: 1 }),
      ),
    ]);
    const config = JSON.parse((await server.services.vaults.readMeta("a", "config.json"))!);
    expect(config).toMatchObject({ other: 1, pluginTools: { listed: true } });
  });

  it("does not offer a tool that declares vault or reason itself", async () => {
    const { root, mia } = await world();
    const bad = [
      {
        name: "clash",
        description: "x",
        inputSchema: schema({ reason: { type: "string" } }),
      },
    ];
    // The validator refuses such a manifest at install time.
    const res = await root.client.post("/api/vaults/a/plugins", {
      files: asRequestFiles(pluginFiles(SERVER_JS, { contributes: { tools: bad } })),
    });
    expect(res.status).toBe(400);
    void mia;
  });

  it("reports a plugin's own exception as a failure with the message", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia);
    const r = await a.plugin("boom");
    expect(r.error.code).toBe("internal");
    expect(r.error.message).toContain("TypeError: nope");
    expect((await a.plugin("summarize", { folder: "notes" })).result.files).toHaveLength(1);
  });

  it("stops a plugin that loops, hangs, floods the host or eats memory, and other calls keep working", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia);
    for (const tool of ["spin", "hang"]) {
      const r = await a.plugin(tool);
      expect(r.error, tool).toMatchObject({ code: "unavailable", details: { kind: "timeout" } });
    }
    const flood = await a.plugin("flood");
    expect(flood.error.message).toContain("quota");
    const bomb = await a.plugin("bomb");
    expect(bomb.error.code).toBe("unavailable");
    // Two workers, several poisoned ones replaced: the next calls are served normally, in parallel too.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => a.plugin("summarize", { folder: "notes" })),
    );
    for (const r of results) expect(r.result.files).toEqual(["notes/one.md"]);
  });

  it("does not let a spinning plugin delay the other plugin calls that run beside it", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia);
    const spinning = a.plugin("spin");
    const t0 = Date.now();
    const quick = await a.plugin("summarize", { folder: "notes" });
    expect(quick.result.files).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(500);
    expect((await spinning).error.code).toBe("unavailable");
  });

  it("refuses to run files that changed after approval", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia);
    expect((await a.plugin("summarize", { folder: "notes" })).result).toBeDefined();
    await server.services.vaults.writeMetaBytes(
      "a",
      "plugins/decider/server.js",
      new TextEncoder().encode(SERVER_JS.replace("hello", "tampered") + "\n// edited"),
    );
    const r = await a.plugin("summarize", { folder: "notes" });
    expect(r.error.code).toBe("plugin_not_approved");
  });

  it("runs a new version only after it is approved", async () => {
    const { root, mia } = await world();
    await install(root);
    const a = await ai(mia);
    const v2 = pluginFiles(SERVER_JS.replace("listed", "second"), { version: "1.1.0" });
    await root.client.post("/api/vaults/a/plugins", { files: asRequestFiles(v2) });
    expect(JSON.stringify(await a.call("list_tools"))).not.toContain("decider.");
    const row = await json<Json>(await root.client.get("/api/vaults/a/plugins/decider"));
    await root.client.post("/api/vaults/a/plugins/decider/approve", { sha256: row.sha256 });
    expect((await a.plugin("summarize", { folder: "notes" })).logs).toEqual(["second 1"]);
  });
});
