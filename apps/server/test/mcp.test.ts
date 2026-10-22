import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { maskOf } from "@palimvo/core";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool } from "../src/mcp/registry.ts";
import { TOOLS_LIST_BUDGET_BYTES } from "../src/mcp/server.ts";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const calls: { tool: string; vault: string; author: string; reason: string | undefined }[] = [];

const record =
  (tool: string) =>
  (
    _args: unknown,
    ctx: { vault: string; author: { name: string }; note: { reason?: string | undefined } },
  ) => {
    calls.push({ tool, vault: ctx.vault, author: ctx.author.name, reason: ctx.note.reason });
    return { ok: true, tool };
  };

const probeTools = [
  defineTool({
    name: "probe_read",
    tier: "native",
    scope: "vault",
    permission: "note.read",
    input: z.object({ path: z.string() }),
    description: "Read something. Test tool.",
    handler: record("probe_read"),
  }),
  defineTool({
    name: "probe_write",
    tier: "native",
    scope: "vault",
    permission: "note.write",
    writes: true,
    input: z.object({ path: z.string() }),
    description: "Write something. Test tool.",
    handler: record("probe_write"),
  }),
  defineTool({
    name: "probe_propose",
    tier: "native",
    scope: "vault",
    permission: "proposal.create",
    writes: true,
    input: z.object({}),
    description: "Propose something. Test tool.",
    handler: record("probe_propose"),
  }),
  defineTool({
    name: "probe_advanced",
    tier: "advanced",
    scope: "vault",
    permission: "note.write",
    writes: true,
    input: z.object({ n: z.number().int() }),
    description: "An advanced tool. It has a longer description.",
    handler: record("probe_advanced"),
  }),
  defineTool({
    name: "probe_admin",
    tier: "advanced",
    scope: "server",
    permission: "server.manage",
    input: z.object({}),
    description: "Server-wide tool for administrators.",
    handler: () => ({ admin: true }),
  }),
  defineTool({
    name: "probe_open",
    tier: "advanced",
    scope: "vault",
    permission: [],
    input: z.object({}),
    description: "Declares no permission; still needs a visible vault.",
    handler: record("probe_open"),
  }),
  defineTool({
    name: "probe_boom",
    tier: "native",
    scope: "server",
    permission: [],
    input: z.object({}),
    description: "Always fails.",
    handler: () => {
      throw new Error("secret internals");
    },
  }),
];

let server: TestServer;

beforeEach(async () => {
  calls.length = 0;
  server = await startTestServer(
    { publicUrl: "https://palimvo.test" },
    {
      mcp: {
        tools: probeTools,
        providers: [
          {
            toolsFor: (vault) =>
              vault === "a"
                ? [
                    defineTool({
                      name: "plugin_hello",
                      tier: "native", // providers cannot claim a spot in tools/list
                      scope: "vault",
                      permission: "note.read",
                      input: z.object({}),
                      description: "From a plugin enabled in vault a.",
                      handler: record("plugin_hello"),
                    }),
                  ]
                : [],
          },
        ],
      },
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

type Result = { isError?: boolean; content: { type: string; text: string }[] };
// Test results are poked at freely; their shape is checked by the assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: unknown) => JSON.parse((r as Result).content[0]!.text) as Record<string, any>;
const names = async (c: McpClient) => (await c.listTools()).tools.map((t) => t.name);

describe("connecting", () => {
  it("asks for a bearer secret and points to OAuth discovery", async () => {
    const res = await server.fetch("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
    expect((await server.fetch("/mcp/a", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("is stateless POST only, with CORS for browser clients", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "x", access: "write" });
    const get = await server.fetch("/mcp", { headers: { authorization: `Bearer ${secret}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const pre = await server.fetch("/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://claude.ai", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("tells the client how to use it", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "x", access: "write" });
    const all = await connect("/mcp", secret);
    expect(all.getInstructions()).toContain("list_vaults");
    expect(all.getServerVersion()?.name).toBe("palimvo");
    const one = await connect("/mcp/a", secret);
    expect(one.getInstructions()).not.toContain("list_vaults");
    expect(one.getInstructions()).toContain("list_tools");
  });
});

describe("tools/list", () => {
  it("lists native tools plus the three entry tools, and hides advanced and plugin tools", async () => {
    const { mia } = await world();
    const c = await connect("/mcp", await makeToken(mia, { name: "x", access: "write" }));
    const list = await names(c);
    expect(list).toEqual(
      expect.arrayContaining([
        "list_vaults",
        "list_tools",
        "describe_tool",
        "call_tool",
        "probe_read",
        "probe_write",
      ]),
    );
    expect(list).not.toContain("probe_advanced");
    expect(list).not.toContain("probe_admin");
    expect(list).not.toContain("plugin_hello");
  });

  it("adds `vault` (and `reason` for changes) on /mcp, and neither `vault` on /mcp/:vault", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "x", access: "write" });
    const all = (await (await connect("/mcp", secret)).listTools()).tools;
    const w = all.find((t) => t.name === "probe_write")!;
    expect(w.inputSchema.required).toEqual(expect.arrayContaining(["path", "vault", "reason"]));
    expect(w.annotations).toMatchObject({ readOnlyHint: false });
    expect(all.find((t) => t.name === "probe_read")!.annotations).toMatchObject({
      readOnlyHint: true,
    });
    const one = (await (await connect("/mcp/a", secret)).listTools()).tools;
    const w1 = one.find((t) => t.name === "probe_write")!;
    expect(Object.keys(w1.inputSchema.properties ?? {})).toEqual(["path", "reason"]);
    expect(one.map((t) => t.name)).not.toContain("list_vaults");
  });

  it("only offers what the token may do", async () => {
    const { mia } = await world();
    const read = await names(
      await connect("/mcp", await makeToken(mia, { name: "r", access: "read" })),
    );
    expect(read).toContain("probe_read");
    expect(read).not.toContain("probe_write");
    expect(read).not.toContain("probe_propose");
    const propose = await names(
      await connect("/mcp", await makeToken(mia, { name: "p", access: "propose" })),
    );
    expect(propose).toContain("probe_propose");
    expect(propose).not.toContain("probe_write");
  });

  it("stays within the size budget", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "x", access: "write" });
    for (const path of ["/mcp", "/mcp/a"]) {
      const bytes = JSON.stringify((await (await connect(path, secret)).listTools()).tools).length;
      expect(bytes, path).toBeLessThan(TOOLS_LIST_BUDGET_BYTES);
    }
  });
});

describe("list_vaults", () => {
  it("shows only the vaults the token covers, with what may be done there", async () => {
    const { mia } = await world();
    const only = await connect(
      "/mcp",
      await makeToken(mia, { name: "a", access: "write", vaultId: "a" }),
    );
    expect(body(await only.callTool({ name: "list_vaults", arguments: {} })).vaults).toEqual([
      { id: "a", access: "write" },
    ]);
    const prop = await connect("/mcp", await makeToken(mia, { name: "p", access: "propose" }));
    expect(body(await prop.callTool({ name: "list_vaults", arguments: {} })).vaults).toEqual([
      { id: "a", access: "propose" },
      { id: "b", access: "propose" },
    ]);
  });
});

describe("calling tools", () => {
  it("runs a change with the AI client's name and reason, and audits it", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "token-name", access: "write" });
    const c = await connect("/mcp", secret, { "x-palimvo-author": "ai:Claude%20Code" });
    const r = await c.callTool({
      name: "probe_write",
      arguments: { vault: "a", path: "x.md", reason: "tidy up" },
    });
    expect(body(r)).toEqual({ ok: true, tool: "probe_write" });
    expect(calls).toEqual([
      { tool: "probe_write", vault: "a", author: "Claude Code", reason: "tidy up" },
    ]);
    const audit = server.store.audit.query({ action: "mcp.probe_write" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "token",
      actorLabel: "token-name",
      vaultId: "a",
      detail: { outcome: "ok", author: "Claude Code", reason: "tidy up" },
    });
    // Reads are not audited.
    await c.callTool({ name: "probe_read", arguments: { vault: "a", path: "x.md" } });
    expect(server.store.audit.query({ action: "mcp.probe_read" })).toHaveLength(0);
  });

  it("credits the token when the client does not say who it is, and takes the reason from the header", async () => {
    const { mia } = await world();
    const c = await connect("/mcp/a", await makeToken(mia, { name: "My Agent", access: "write" }), {
      "x-palimvo-reason": "from%20header",
    });
    body(await c.callTool({ name: "probe_write", arguments: { path: "x.md" } }));
    expect(calls[0]).toMatchObject({ author: "My Agent", reason: "from header", vault: "a" });
  });

  it("refuses a change without a reason", async () => {
    const { mia } = await world();
    const c = await connect("/mcp", await makeToken(mia, { name: "x", access: "write" }));
    const r = (await c.callTool({
      name: "probe_write",
      arguments: { vault: "a", path: "x.md" },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("invalid_request");
    expect(body(r).error.message).toContain("reason");
    expect(calls).toHaveLength(0);
    expect(server.store.audit.query({ action: "mcp.probe_write" })[0]?.detail).toMatchObject({
      outcome: "failed",
    });
  });

  it("does not accept a blank reason from the header", async () => {
    const { mia } = await world();
    const c = await connect("/mcp/a", await makeToken(mia, { name: "x", access: "write" }), {
      "x-palimvo-reason": "%20",
    });
    const r = body(await c.callTool({ name: "probe_write", arguments: { path: "x.md" } }));
    expect(r.error.code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("needs a vault on /mcp and rejects other vaults on /mcp/:vault", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "x", access: "write" });
    const all = await connect("/mcp", secret);
    const missing = body(await all.callTool({ name: "probe_read", arguments: { path: "x" } }));
    expect(missing.error.code).toBe("invalid_request");
    const one = await connect("/mcp/a", secret);
    const other = body(
      await one.callTool({ name: "probe_read", arguments: { vault: "b", path: "x" } }),
    );
    expect(other.error.code).toBe("token_scope_denied");
    expect(calls).toHaveLength(0);
  });

  it("keeps a vault-bound token inside its vault", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "x", access: "write", vaultId: "a" });
    const c = await connect("/mcp", secret);
    const denied = body(
      await c.callTool({ name: "probe_read", arguments: { vault: "b", path: "x" } }),
    );
    expect(["token_scope_denied", "vault_not_found"]).toContain(denied.error.code);
    expect(calls).toHaveLength(0);
    const res = await server.fetch("/mcp/b", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect([403, 404]).toContain(res.status);
  });

  it("tells a propose-only token that it can only propose", async () => {
    const { mia } = await world();
    const c = await connect("/mcp", await makeToken(mia, { name: "p", access: "propose" }));
    const r = body(
      await c.callTool({ name: "probe_write", arguments: { vault: "a", path: "x", reason: "r" } }),
    );
    expect(r.error.code).toBe("propose_only");
    expect(server.store.audit.query({ action: "mcp.probe_write" })[0]?.detail).toMatchObject({
      outcome: "denied",
    });
    expect(
      body(await c.callTool({ name: "probe_propose", arguments: { vault: "a", reason: "r" } })).ok,
    ).toBe(true);
  });

  it("requires a visible vault even for tools that declare no permission", async () => {
    const { mia } = await world();
    const c = await connect(
      "/mcp",
      await makeToken(mia, { name: "x", access: "write", vaultId: "a" }),
    );
    expect(
      body(await c.callTool({ name: "call_tool", arguments: { name: "probe_open", vault: "a" } }))
        .ok,
    ).toBe(true);
    const hidden = body(
      await c.callTool({ name: "call_tool", arguments: { name: "probe_open", vault: "nope" } }),
    );
    expect(["vault_not_found", "token_scope_denied"]).toContain(hidden.error.code);
    const other = body(
      await c.callTool({ name: "call_tool", arguments: { name: "probe_open", vault: "b" } }),
    );
    expect(other.ok).toBeUndefined();
  });

  it("answers unknown tools and crashes as results, without leaking internals", async () => {
    const { mia } = await world();
    const c = await connect("/mcp", await makeToken(mia, { name: "x", access: "write" }));
    const unknown = (await c.callTool({ name: "nope", arguments: {} })) as Result;
    expect(unknown.isError).toBe(true);
    expect(body(unknown).error.code).toBe("not_found");
    const boom = (await c.callTool({ name: "probe_boom", arguments: {} })) as Result;
    expect(boom.isError).toBe(true);
    expect(JSON.stringify(body(boom))).not.toContain("secret internals");
    expect(body(boom).error.code).toBe("internal");
  });

  it("follows permission changes made after the token was created", async () => {
    const { mia } = await world();
    const c = await connect("/mcp", await makeToken(mia, { name: "x", access: "write" }));
    const write = { vault: "a", path: "x", reason: "r" };
    expect(body(await c.callTool({ name: "probe_write", arguments: write })).ok).toBe(true);
    server.store.roles.setOverride(
      { scope: "vault", vaultId: "a", subjectType: "account", subjectId: mia.id },
      { allow: 0, deny: maskOf(["note.write"]) },
    );
    server.auth.access.invalidate();
    expect(body(await c.callTool({ name: "probe_write", arguments: write })).error.code).toBe(
      "forbidden",
    );
    // Vault b is untouched, so the tool is still offered.
    expect(await names(c)).toContain("probe_write");
    const only = await connect("/mcp/a", await makeToken(mia, { name: "y", access: "write" }));
    expect(await names(only)).not.toContain("probe_write");
  });
});

describe("entry tools", () => {
  it("list_tools shows advanced tools, and plugin tools once a vault is named", async () => {
    const { mia } = await world();
    const c = await connect("/mcp", await makeToken(mia, { name: "x", access: "write" }));
    const plain = body(await c.callTool({ name: "list_tools", arguments: {} }));
    expect(plain.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "get_edit_proposal",
      "list_edit_proposals",
      "probe_advanced",
      "probe_open",
    ]);
    expect(plain.tools.find((t: { name: string }) => t.name === "probe_advanced")).toMatchObject({
      summary: "An advanced tool.",
      writes: true,
    });
    const inA = body(await c.callTool({ name: "list_tools", arguments: { vault: "a" } }));
    expect(inA.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "get_edit_proposal",
      "list_edit_proposals",
      "plugin_hello",
      "probe_advanced",
      "probe_open",
    ]);
    const inB = body(await c.callTool({ name: "list_tools", arguments: { vault: "b" } }));
    expect(inB.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "get_edit_proposal",
      "list_edit_proposals",
      "probe_advanced",
      "probe_open",
    ]);
    const q = body(
      await c.callTool({ name: "list_tools", arguments: { vault: "a", query: "plugin" } }),
    );
    expect(q.total).toBe(1);
  });

  it("never offers server-wide administration to a token, even an administrator's", async () => {
    const { root } = await world();
    const admin = await connect("/mcp", await makeToken(root, { name: "root", access: "write" }));
    expect(
      JSON.stringify(body(await admin.callTool({ name: "list_tools", arguments: {} }))),
    ).not.toContain("probe_admin");
    const denied = body(
      await admin.callTool({ name: "call_tool", arguments: { name: "probe_admin" } }),
    );
    expect(denied.error.code).toBe("token_scope_denied");
    expect(
      (await admin.callTool({
        name: "describe_tool",
        arguments: { name: "probe_admin" },
      })) as Result,
    ).toMatchObject({ isError: true });
  });

  it("describe_tool returns the schema the caller must use", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "x", access: "write" });
    const c = await connect("/mcp", secret);
    const d = body(
      await c.callTool({ name: "describe_tool", arguments: { name: "probe_advanced" } }),
    );
    expect(d.writes).toBe(true);
    expect(d.arguments.required).toEqual(expect.arrayContaining(["n", "vault", "reason"]));
    const one = await connect("/mcp/a", secret);
    const d1 = body(
      await one.callTool({ name: "describe_tool", arguments: { name: "probe_advanced" } }),
    );
    expect(d1.arguments.properties.vault).toBeUndefined();
    const missing = (await c.callTool({
      name: "describe_tool",
      arguments: { name: "nope" },
    })) as Result;
    expect(missing.isError).toBe(true);
  });

  it("call_tool runs advanced and plugin tools with the same checks and history", async () => {
    const { mia } = await world();
    const c = await connect("/mcp", await makeToken(mia, { name: "x", access: "write" }), {
      "x-palimvo-author": "ai:Cursor",
    });
    const ok = body(
      await c.callTool({
        name: "call_tool",
        arguments: { name: "probe_advanced", vault: "a", arguments: { n: 3, reason: "advance" } },
      }),
    );
    expect(ok.ok).toBe(true);
    expect(calls.at(-1)).toEqual({
      tool: "probe_advanced",
      vault: "a",
      author: "Cursor",
      reason: "advance",
    });
    expect(server.store.audit.query({ action: "mcp.probe_advanced" })).toHaveLength(1);

    const plugin = body(
      await c.callTool({ name: "call_tool", arguments: { name: "plugin_hello", vault: "a" } }),
    );
    expect(plugin.tool).toBe("plugin_hello");
    // The plugin is only enabled in vault a.
    const b = (await c.callTool({
      name: "call_tool",
      arguments: { name: "plugin_hello", vault: "b" },
    })) as Result;
    expect(body(b).error.code).toBe("not_found");

    const bad = body(
      await c.callTool({
        name: "call_tool",
        arguments: { name: "probe_advanced", vault: "a", arguments: { n: "three", reason: "r" } },
      }),
    );
    expect(bad.error.code).toBe("invalid_request");
    expect(bad.error.message).toContain("n:");
  });

  it("call_tool cannot be used to run itself, and checks read-only tokens", async () => {
    const { mia } = await world();
    const c = await connect("/mcp", await makeToken(mia, { name: "r", access: "read" }));
    const nested = body(
      await c.callTool({ name: "call_tool", arguments: { name: "call_tool", arguments: {} } }),
    );
    expect(nested.error.code).toBe("invalid_request");
    const write = body(
      await c.callTool({
        name: "call_tool",
        arguments: { name: "probe_advanced", vault: "a", arguments: { n: 1, reason: "r" } },
      }),
    );
    expect(write.error.code).toBe("token_scope_denied");
    expect(calls).toHaveLength(0);
  });
});

describe("limits", () => {
  it("applies the token's rate limit to MCP calls", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "slow", access: "read", rateLimitPerMinute: 2 });
    const post = () =>
      server.fetch("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("rejects bodies that are far too large", async () => {
    const { mia } = await world();
    const secret = await makeToken(mia, { name: "x", access: "write" });
    const res = await server.fetch("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: Buffer.alloc(93 * 1024 * 1024, 0x20),
    });
    expect(res.status).toBe(413);
  });
});
