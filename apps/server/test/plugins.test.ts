import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MANIFEST_LIMITS } from "@palimvo/plugin-sdk";
import { asRequestFiles, file, samplePackage } from "../src/plugins/testing.ts";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const BASE = "https://palimvo.test";
const REDIRECT = "https://claude.example/callback";

let server: TestServer;
beforeEach(async () => {
  server = await startTestServer({ publicUrl: BASE });
});
afterEach(() => server.dispose());

// Results are poked at freely; their shape is checked by the assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

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

/** A server administrator who owns vault `a`, and a plain member of it. */
async function world() {
  const root = await signIn("root", true);
  expect((await root.client.post("/api/vaults", { id: "a" })).status).toBe(201);
  const mia = await signIn("mia");
  server.store.joinVault("a", mia.id, "member");
  return { root, mia };
}

const publish = (c: Client, files = samplePackage()) =>
  c.post("/api/plugin-library", { files: asRequestFiles(files) });

async function installed(c: Client, id: string, vault = "a") {
  return json<Json>(await c.get(`/api/vaults/${vault}/plugins/${id}`));
}

describe("plugin library", () => {
  it("lets only library publishers add versions, and versions are immutable", async () => {
    const { root, mia } = await world();
    expect((await publish(mia.client)).status).toBe(403);
    expect((await publish(new Client(server))).status).toBe(401);

    const res = await publish(root.client);
    expect(res.status).toBe(201);
    const entry = await json<Json>(res);
    expect(entry).toMatchObject({ id: "board", version: "1.0.0", builtin: false });
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect((await publish(root.client)).status).toBe(409);
    expect((await publish(root.client, samplePackage("board", "1.1.0"))).status).toBe(201);

    // Anyone signed in can look, nobody anonymous.
    const list = await json<{ plugins: Json[] }>(await mia.client.get("/api/plugin-library"));
    expect(list.plugins.map((p) => `${p.id}@${p.version}`).sort()).toEqual([
      "board@1.0.0",
      "board@1.1.0",
    ]);
    expect((await new Client(server).get("/api/plugin-library")).status).toBe(401);
  });

  it("rejects bad packages with the reasons", async () => {
    const { root } = await world();
    const missing = await root.client.post("/api/plugin-library", {
      files: [asRequestFiles(samplePackage())[0]],
    });
    expect(missing.status).toBe(400);
    const body = await json<Json>(missing);
    expect(body.code).toBe("plugin_invalid");
    expect(body.details.issues[0]).toMatchObject({ code: "missing_file", path: "main.js" });

    const huge = await root.client.post("/api/plugin-library", {
      files: [
        ...asRequestFiles(samplePackage()),
        {
          path: "big.bin",
          base64: Buffer.alloc(MANIFEST_LIMITS.packageBytes + 1).toString("base64"),
        },
      ],
    });
    expect([400, 413]).toContain(huge.status);
    const both = await root.client.post("/api/plugin-library", {
      files: [{ path: "manifest.json", text: "{}", base64: "e30=" }],
    });
    expect(both.status).toBe(400);
  });

  it("removes versions but never official plugins", async () => {
    const { root, mia } = await world();
    await publish(root.client);
    await publish(root.client, samplePackage("board", "1.1.0"));
    expect((await mia.client.del("/api/plugin-library/board/1.0.0")).status).toBe(403);
    expect((await root.client.del("/api/plugin-library/board/1.0.0")).status).toBe(200);
    expect((await root.client.del("/api/plugin-library/board/1.0.0")).status).toBe(404);
    const list = await json<{ plugins: Json[] }>(await root.client.get("/api/plugin-library"));
    expect(list.plugins.map((p) => p.version)).toEqual(["1.1.0"]);

    const dir = await mkdtemp(path.join(tmpdir(), "palimvo-official-"));
    try {
      await mkdir(path.join(dir, "good"));
      for (const f of samplePackage("good", "1.0.0")) {
        await writeFile(path.join(dir, "good", f.path), f.bytes);
      }
      // Missing main.js: skipped, as the official folders are until their code lands.
      await mkdir(path.join(dir, "empty"));
      await writeFile(path.join(dir, "empty", "manifest.json"), samplePackage("empty")[0]!.bytes);
      const manager = server.services.plugins;
      expect(await manager.seedBuiltins(dir)).toEqual(["good@1.0.0"]);
      expect(await manager.seedBuiltins(dir)).toEqual([]);
      const all = await json<{ plugins: Json[] }>(await root.client.get("/api/plugin-library"));
      expect(all.plugins.find((p) => p.id === "good")?.builtin).toBe(true);
      expect(all.plugins.find((p) => p.id === "empty")).toBeUndefined();
      expect((await root.client.del("/api/plugin-library/good")).status).toBe(403);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the official plugins of this repository", () => {
  it("pass the package checks on a development build and install in a vault, except the one whose code is not written yet", async () => {
    const { root } = await world();
    const dir = path.resolve(import.meta.dirname, "../../../plugins");
    // plugins/examples/ (chart-pack, json-tree and the UI-layer demos) is for plugin authors.
    expect((await server.services.plugins.seedBuiltins(dir)).sort()).toEqual([
      "graph@1.0.0",
      "kanban-due@1.0.0",
      "kanban@1.0.0",
    ]);
    const library = await json<{ plugins: Json[] }>(await root.client.get("/api/plugin-library"));
    expect(library.plugins.map((p) => p.id).sort()).toEqual(["graph", "kanban", "kanban-due"]);
    // In the library, but not installed anywhere until a person picks one.
    const before = await json<{ plugins: Json[] }>(await root.client.get("/api/vaults/a/plugins"));
    expect(before.plugins).toEqual([]);
    const res = await root.client.post("/api/vaults/a/plugins", {
      library: { id: "kanban-due" },
    });
    expect(res.status).toBe(201);
    const after = await json<{ plugins: Json[] }>(await root.client.get("/api/vaults/a/plugins"));
    // Installed switched off: a person still has to approve and enable it.
    expect(after.plugins.map((p) => [p.id, p.enabled])).toEqual([["kanban-due", false]]);
  });
});

describe("installing and approving in a vault", () => {
  it("installs switched off, runs only after a person approves the exact hash", async () => {
    const { root, mia } = await world();
    await publish(root.client);

    // Members cannot install.
    expect(
      (await mia.client.post("/api/vaults/a/plugins", { library: { id: "board" } })).status,
    ).toBe(403);

    const res = await root.client.post("/api/vaults/a/plugins", { library: { id: "board" } });
    expect(res.status).toBe(201);
    const first = await json<Json>(res);
    expect(first).toMatchObject({
      id: "board",
      enabled: false,
      approved: false,
      state: "disabled",
    });
    expect(first.summary.read).toEqual(["notes"]);

    // Switching on does not skip approval.
    const on = await json<Json>(
      await root.client.patch("/api/vaults/a/plugins/board", { enabled: true }),
    );
    expect(on.state).toBe("needs_approval");
    expect(server.services.plugins.enabled("a")).toEqual([]);
    expect((await mia.client.get("/api/vaults/a/plugins/board/files/main.js")).status).toBe(403);

    // A wrong hash approves nothing.
    expect(
      (await root.client.post("/api/vaults/a/plugins/board/approve", { sha256: "0".repeat(64) }))
        .status,
    ).toBe(409);
    // Members cannot approve.
    expect(
      (await mia.client.post("/api/vaults/a/plugins/board/approve", { sha256: first.sha256 }))
        .status,
    ).toBe(403);

    const approved = await json<Json>(
      await root.client.post("/api/vaults/a/plugins/board/approve", { sha256: first.sha256 }),
    );
    expect(approved).toMatchObject({ approved: true, state: "running" });
    expect(server.services.plugins.enabled("a")).toEqual([{ id: "board", version: "1.0.0" }]);

    // Members can load what runs.
    const code = await mia.client.get("/api/vaults/a/plugins/board/files/main.js");
    expect(code.status).toBe(200);
    expect(code.headers.get("content-type")).toContain("javascript");
    expect(code.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await code.text()).toBe("export default () => {};");

    const detail = await installed(root.client, "board");
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0].approvedBy).toBe(root.id);
  });

  it("serves the running plugins and their text to the web host", async () => {
    const { root, mia } = await world();
    const pub = await publish(
      root.client,
      samplePackage("board", "1.0.0", {
        locales: { "zh-TW": "zh-TW.json" },
        contributes: {
          views: [{ id: "main", name: { en: "Main" } }],
          theme: { name: "Dark", css: "theme.css" },
        },
      }).concat([
        file("zh-TW.json", '{"a":"b"}'),
        file("theme.css", ":root{}"),
        file("other.txt", "x"),
      ]),
    );
    expect(pub.status).toBe(201);
    const first = await json<Json>(
      await root.client.post("/api/vaults/a/plugins", { library: { id: "board" } }),
    );
    // Nothing runs until it is on and approved.
    expect(
      (await json<Json>(await mia.client.get("/api/vaults/a/plugin-runtime"))).plugins,
    ).toEqual([]);
    await root.client.patch("/api/vaults/a/plugins/board", { enabled: true });
    expect((await mia.client.get("/api/vaults/a/plugin-runtime/board")).status).toBe(403);
    await root.client.post("/api/vaults/a/plugins/board/approve", { sha256: first.sha256 });

    const listRes = await mia.client.get("/api/vaults/a/plugin-runtime");
    expect(listRes.headers.get("cache-control")).toContain("no-store");
    const list = await json<Json>(listRes);
    expect(list.plugins).toHaveLength(1);
    expect(list.plugins[0]).toMatchObject({ id: "board", version: "1.0.0", hash: first.sha256 });
    expect(list.plugins[0].manifest.id).toBe("board");

    const bundle = await json<Json>(await mia.client.get("/api/vaults/a/plugin-runtime/board"));
    expect(bundle).toMatchObject({ id: "board", hash: first.sha256 });
    expect(Object.keys(bundle.files).sort()).toEqual(["main.js", "theme.css", "zh-TW.json"]);
    expect(bundle.files["main.js"]).toBe("export default () => {};");

    // Switching off takes it out of both.
    await root.client.patch("/api/vaults/a/plugins/board", { enabled: false });
    expect(
      (await json<Json>(await mia.client.get("/api/vaults/a/plugin-runtime"))).plugins,
    ).toEqual([]);
    expect((await mia.client.get("/api/vaults/a/plugin-runtime/board")).status).toBe(403);
  });

  it("needs approval again after a single changed byte, and remembers hashes", async () => {
    const { root } = await world();
    const v1 = samplePackage("board", "1.0.0");
    const edited = samplePackage("board", "1.0.0", {}, "export default () => { };");
    const install = async (files: typeof v1) =>
      json<Json>(await root.client.post("/api/vaults/a/plugins", { files: asRequestFiles(files) }));
    const approve = async (p: Json) =>
      json<Json>(
        await root.client.post("/api/vaults/a/plugins/board/approve", { sha256: p.sha256 }),
      );

    const first = await install(v1);
    await root.client.patch("/api/vaults/a/plugins/board", { enabled: true });
    expect((await approve(first)).state).toBe("running");

    // Same version number, one space more: a different package.
    const second = await install(edited);
    expect(second.sha256).not.toBe(first.sha256);
    // The on/off switch stays on across an update, but the new hash is not approved.
    expect(second).toMatchObject({ enabled: true, approved: false, state: "needs_approval" });
    expect((await root.client.get("/api/vaults/a/plugins/board/files/main.js")).status).toBe(403);

    // Putting the approved bytes back is approved already.
    const back = await install(v1);
    expect(back).toMatchObject({ sha256: first.sha256, approved: true, state: "running" });
  });

  it("refuses files that were changed on disk after approval", async () => {
    const { root } = await world();
    const p = await json<Json>(
      await root.client.post("/api/vaults/a/plugins", {
        files: asRequestFiles(samplePackage("board")),
      }),
    );
    await root.client.patch("/api/vaults/a/plugins/board", { enabled: true });
    await root.client.post("/api/vaults/a/plugins/board/approve", { sha256: p.sha256 });
    expect((await root.client.get("/api/vaults/a/plugins/board/files/main.js")).status).toBe(200);

    const onDisk = path.join(
      server.dataDir,
      "vaults",
      "a",
      ".palimvo",
      "plugins",
      "board",
      "main.js",
    );
    await writeFile(onDisk, "fetch('https://evil.example')");
    const blocked = await root.client.get("/api/vaults/a/plugins/board/files/main.js");
    expect(blocked.status).toBe(403);
    expect((await json<Json>(blocked)).code).toBe("plugin_not_approved");
    // The review screen still shows what is on disk, and approving it is refused.
    const review = await json<{ files: Json[] }>(
      await root.client.get("/api/vaults/a/plugins/board/package"),
    );
    expect(review.files.find((f) => f.path === "main.js")?.text).toContain("evil.example");
    expect(
      (await root.client.post("/api/vaults/a/plugins/board/approve", { sha256: p.sha256 })).status,
    ).toBe(400);
  });

  it("revokes, switches off and uninstalls", async () => {
    const { root } = await world();
    const p = await json<Json>(
      await root.client.post("/api/vaults/a/plugins", {
        files: asRequestFiles(samplePackage("board")),
      }),
    );
    await root.client.patch("/api/vaults/a/plugins/board", { enabled: true });
    await root.client.post("/api/vaults/a/plugins/board/approve", { sha256: p.sha256 });
    expect(
      (await json<Json>(await root.client.post("/api/vaults/a/plugins/board/revoke"))).state,
    ).toBe("needs_approval");
    await root.client.post("/api/vaults/a/plugins/board/approve", { sha256: p.sha256 });
    expect(
      (await json<Json>(await root.client.patch("/api/vaults/a/plugins/board", { enabled: false })))
        .state,
    ).toBe("disabled");

    expect((await root.client.del("/api/vaults/a/plugins/board")).status).toBe(200);
    expect((await root.client.get("/api/vaults/a/plugins/board")).status).toBe(404);
    expect(await server.services.vaults.listMetaFiles("a", "plugins/board")).toEqual([]);
    // Gone for good: installing again starts unapproved.
    const again = await json<Json>(
      await root.client.post("/api/vaults/a/plugins", {
        files: asRequestFiles(samplePackage("board")),
      }),
    );
    expect(again.approved).toBe(false);
  });

  it("resolves dependencies between plugins", async () => {
    const { root } = await world();
    const put = async (files: ReturnType<typeof samplePackage>) => {
      const p = await json<Json>(
        await root.client.post("/api/vaults/a/plugins", { files: asRequestFiles(files) }),
      );
      await root.client.patch(`/api/vaults/a/plugins/${p.id}`, { enabled: true });
      await root.client.post(`/api/vaults/a/plugins/${p.id}/approve`, { sha256: p.sha256 });
      return p.id as string;
    };
    await put(samplePackage("child", "1.0.0", { dependencies: { base: "^1.0.0" } }));
    expect((await installed(root.client, "child")).state).toBe("blocked");
    expect((await installed(root.client, "child")).problems[0].code).toBe("dependency_missing");
    await put(samplePackage("base", "2.0.0"));
    expect((await installed(root.client, "child")).problems[0].code).toBe("dependency_version");
    await put(samplePackage("base", "1.2.0"));
    expect((await installed(root.client, "child")).state).toBe("running");
    expect(server.services.plugins.enabled("a").map((p) => p.id)).toEqual(["base", "child"]);
    await root.client.patch("/api/vaults/a/plugins/base", { enabled: false });
    expect((await installed(root.client, "child")).state).toBe("blocked");
  });

  it("forgets a vault's plugins when its id is reused", async () => {
    const { root } = await world();
    const p = await json<Json>(
      await root.client.post("/api/vaults/a/plugins", {
        files: asRequestFiles(samplePackage("board")),
      }),
    );
    server.store.plugins.approve({
      vaultId: "a",
      pluginId: "board",
      sha256: p.sha256,
      version: "1.0.0",
      permissions: {},
    });
    server.store.accounts.deleteVaultData("a");
    expect(server.store.plugins.list("a")).toEqual([]);
    expect(server.store.plugins.approvals("a")).toEqual([]);
  });
});

// ---- MCP --------------------------------------------------------------------------------------

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function oauthToken(user: string, admin: boolean): Promise<string> {
  const reg = await server.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
  });
  const { client_id } = await json<{ client_id: string }>(reg);
  const verifier = randomBytes(32).toString("base64url");
  const fields = Object.fromEntries(
    new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "mcp:write",
      resource: `${BASE}/mcp`,
    }),
  );
  const browser = new Client(server);
  const login = await browser.request("/oauth/login", {
    ...form({ ...fields, username: user, password: PASSWORD }),
    redirect: "manual",
  });
  const html = await (await browser.request(login.headers.get("location")!)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const res = await browser.request("/oauth/authorize", {
    ...form({
      ...fields,
      csrf,
      decision: "allow",
      access: "write",
      ...(admin ? { admin: "1" } : {}),
    }),
    redirect: "manual",
  });
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
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
  return tokens.access_token;
}

async function connect(secret: string) {
  const client = new McpClient({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    }),
  );
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as {
      content: { text: string }[];
    };
    return JSON.parse(r.content[0]!.text) as Json;
  };
  return {
    call,
    advanced: (name: string, args: Record<string, unknown> = {}) =>
      call("call_tool", { name, arguments: args }),
  };
}

describe("plugin tools over MCP", () => {
  it("lets an admin grant publish and install, but approval stays with people", async () => {
    const { root } = await world();
    const ai = await connect(await oauthToken("root", true));
    const files = asRequestFiles(samplePackage("board"));

    const published = await ai.advanced("publish_library_plugin", {
      files,
      reason: "First release",
    });
    expect(published).toMatchObject({ id: "board", version: "1.0.0" });
    expect(
      (await ai.advanced("publish_library_plugin", { files, reason: "again" })).error.code,
    ).toBe("already_exists");
    const lib = await ai.advanced("list_library_plugins", { vault: "a" });
    expect(lib.plugins.map((p: Json) => p.id)).toEqual(["board"]);

    const added = await ai.advanced("install_library_plugin", {
      vault: "a",
      id: "board",
      reason: "Task board",
    });
    expect(added).toMatchObject({ state: "disabled", approved: false });
    expect(added.next).toContain("person must approve");
    const on = await ai.advanced("set_plugin_enabled", {
      vault: "a",
      id: "board",
      enabled: true,
      reason: "go",
    });
    expect(on.state).toBe("needs_approval");
    // The AI sees the code it installed, with what it asks for.
    const read = await ai.advanced("read_plugin", { vault: "a", id: "board" });
    expect(read.files.map((f: Json) => f.path)).toEqual(["main.js", "manifest.json"]);
    expect(read.permissions.read).toEqual(["notes"]);
    expect(
      (await ai.advanced("read_plugin", { vault: "a", id: "board", path: "main.js" })).text,
    ).toContain("export default");

    // The person approves in the web app.
    const row = await installed(root.client, "board");
    expect(
      (await root.client.post("/api/vaults/a/plugins/board/approve", { sha256: row.sha256 }))
        .status,
    ).toBe(200);
    const listed = await ai.advanced("list_plugins", { vault: "a" });
    expect(listed.plugins[0]).toMatchObject({ id: "board", state: "running" });
    const vaults = await ai.call("list_vaults");
    expect(JSON.stringify(vaults)).toContain("board");

    // Uploaded by the AI: installs unapproved with the warnings, and can be removed again.
    const custom = await ai.advanced("install_plugin", {
      vault: "a",
      files: asRequestFiles(
        samplePackage("mine", "0.1.0", { permissions: { read: ["**"], write: ["**"] } }),
      ),
      reason: "Try it",
    });
    expect(custom).toMatchObject({ id: "mine", state: "disabled" });
    expect(custom.warnings.length).toBeGreaterThan(0);
    expect(
      (await ai.advanced("uninstall_plugin", { vault: "a", id: "mine", reason: "no" })).removed,
    ).toBe("mine");
    expect(
      (await ai.advanced("remove_library_plugin", { id: "board", reason: "cleanup" })).removed,
    ).toBe(1);

    const log = server.store.audit.query({ action: "plugin.install" });
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it("hides the install and publish tools from connections that cannot administer", async () => {
    await world();
    const plain = await connect(await oauthToken("root", false));
    const tools = (await plain.call("list_tools", { limit: 100 })).tools.map((t: Json) => t.name);
    for (const name of ["list_plugins", "list_library_plugins", "read_plugin"])
      expect(tools).toContain(name);
    for (const name of [
      "install_plugin",
      "install_library_plugin",
      "set_plugin_enabled",
      "uninstall_plugin",
      "publish_library_plugin",
      "remove_library_plugin",
    ])
      expect(tools).not.toContain(name);
    const refused = await plain.advanced("install_plugin", {
      vault: "a",
      files: asRequestFiles(samplePackage()),
      reason: "try",
    });
    expect(refused.error.code).toBe("forbidden");
  });
});
