import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asRequestFiles, file } from "../src/plugins/testing.ts";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

// The official decisions plugin (plugins/decisions) installed in a real server and used the way an
// AI client does: through the entry tools, in the sandbox, against a vault with version 1 data.

const PLUGIN = fileURLToPath(new URL("../../../plugins/decisions/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/decisions-v1/", import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Result = { content: { type: string; text?: string }[] };
const body = (r: unknown): Json => JSON.parse((r as Result).content[0]!.text!) as Json;

function folderFiles(root: string, dir = ""): string[] {
  return readdirSync(`${root}${dir}`, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? folderFiles(root, `${dir}${e.name}/`)
      : e.name === "README.md" && dir === "" && root === PLUGIN
        ? []
        : [`${dir}${e.name}`],
  );
}

let server: TestServer;
beforeEach(async () => {
  server = await startTestServer({ publicUrl: "https://palimvo.test" });
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

/** An admin `root` and a vault `a` holding the version 1 fixture, with the plugin installed and approved. */
async function world(seed = true) {
  const root = await signIn("root", true);
  expect((await root.client.post("/api/vaults", { id: "a" })).status).toBe(201);
  if (seed)
    for (const p of folderFiles(FIXTURE))
      await server.services.vaults.writeFile("a", p, readFileSync(`${FIXTURE}${p}`, "utf8"));
  const files = folderFiles(PLUGIN).map((p) => file(p, readFileSync(`${PLUGIN}${p}`, "utf8")));
  const added = await json<Json>(
    await root.client.post("/api/vaults/a/plugins", { files: asRequestFiles(files) }),
  );
  expect(added.id, JSON.stringify(added)).toBe("decisions");
  await root.client.patch("/api/vaults/a/plugins/decisions", { enabled: true });
  const approved = await root.client.post("/api/vaults/a/plugins/decisions/approve", {
    sha256: added.sha256,
  });
  expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200);
  const token = (
    await json<{ secret: string }>(
      await root.client.post("/api/tokens", { name: "Claude", access: "write", vaultId: "a" }),
    )
  ).secret;
  const mcp = new McpClient({ name: "test-client", version: "1.0.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL("/mcp/a", server.url), {
      requestInit: {
        headers: { authorization: `Bearer ${token}`, "x-palimvo-author": "ai:Claude" },
      },
    }),
  );
  const call = async (tool: string, args: Record<string, unknown> = {}) =>
    body(await mcp.callTool({ name: tool, arguments: args }));
  return {
    root,
    call,
    tool: (name: string, args: Record<string, unknown> = {}, reason = "test") =>
      call("call_tool", { name: `decisions.${name}`, arguments: { ...args, reason } }),
    read: async (path: string) =>
      (await json<Json>(await root.client.get(`/api/vaults/a/files/${path}`))).content as string,
  };
}

describe("decisions plugin", () => {
  it("ships the four tools, which appear only through the entry tools", async () => {
    const w = await world();
    const listed = await w.call("list_tools", { query: "decisions." });
    expect(listed.tools.map((t: Json) => t.name).sort()).toEqual([
      "decisions.list_decision_trees",
      "decisions.list_decisions",
      "decisions.record_decision",
      "decisions.update_decision_status",
    ]);
    const write = (n: string) => listed.tools.find((t: Json) => t.name === `decisions.${n}`);
    expect(write("record_decision").writes).toBe(true);
    expect(write("update_decision_status").writes).toBe(true);
    expect(write("list_decisions").writes).toBeUndefined();
  });

  it("reads version 1 records: trees, branches, supersedes and cross-tree requires", async () => {
    const w = await world();
    const { result } = await w.tool("list_decisions");
    expect(result.truncated).toBe(false);
    const by = new Map<string, Json>(result.decisions.map((d: Json) => [d.path, d]));
    expect([...by.keys()]).toEqual([
      "decisions/0005-history-and-decisions.md",
      "decisions/0014-decision-trees.md",
      "MoreMobs/decisions/0005-0.3.1.md",
      "Prism/decisions/0003-API-3.25.md",
      "Prism/decisions/0004-API-3.26.md",
    ]);
    expect(by.get("decisions/0014-decision-trees.md")).toMatchObject({
      number: 14,
      title: "多棵決策樹",
      status: "accepted",
      tree: "",
      deciders: ["Aitchn", "Claude"],
    });
    expect(by.get("Prism/decisions/0004-API-3.26.md")).toMatchObject({
      tree: "Prism",
      branch: "4.x",
      supersedesPath: "Prism/decisions/0003-API-3.25.md",
    });
    expect(by.get("MoreMobs/decisions/0005-0.3.1.md")).toMatchObject({
      tree: "MoreMobs",
      requiresPaths: ["Prism/decisions/0003-API-3.25.md", "Prism/decisions/0004-API-3.26.md"],
      relatedPaths: ["Prism/decisions/0004-API-3.26.md"],
    });
    expect(by.get("Prism/decisions/0003-API-3.25.md")!.requiredBy).toEqual([
      "MoreMobs/decisions/0005-0.3.1.md",
    ]);
    // Filters.
    expect(
      (await w.tool("list_decisions", { status: "proposed" })).result.decisions.map(
        (d: Json) => d.path,
      ),
    ).toEqual(["MoreMobs/decisions/0005-0.3.1.md"]);
    expect(
      (await w.tool("list_decisions", { tree: "Prism" })).result.decisions.map(
        (d: Json) => d.number,
      ),
    ).toEqual([3, 4]);
    expect((await w.tool("list_decisions", { tree: "" })).result.decisions).toHaveLength(2);
  });

  it("summarises the trees, with the trees each one needs", async () => {
    const w = await world();
    const { trees } = (await w.tool("list_decision_trees")).result;
    expect(trees).toEqual([
      { tree: "", folders: ["decisions"], count: 2, statuses: { accepted: 2 }, needs: [] },
      {
        tree: "MoreMobs",
        folders: ["MoreMobs/decisions"],
        count: 1,
        statuses: { proposed: 1 },
        needs: ["Prism"],
      },
      {
        tree: "Prism",
        folders: ["Prism/decisions"],
        count: 2,
        statuses: { superseded: 1, accepted: 1 },
        needs: [],
      },
    ]);
  });

  it("records a decision with the next number in its tree's folder, credited with the reason", async () => {
    const w = await world();
    const plain = await w.tool(
      "record_decision",
      { title: "Use SQLite / not files?", decision: "SQLite.", context: "Why." },
      "Agreed in chat",
    );
    expect(plain.result.path).toBe("decisions/0015-Use-SQLite-not-files.md");
    expect(plain.result.decision).toMatchObject({ number: 15, status: "proposed", tree: "" });
    const text = await w.read("decisions/0015-Use-SQLite-not-files.md");
    expect(text).toContain("status: proposed\n");
    expect(text).toContain("# 0015 Use SQLite / not files?");
    expect(text).toContain("## Context\nWhy.\n");
    expect(text).toContain("## Decision\nSQLite.\n");

    const inTree = await w.tool("record_decision", {
      title: "API 3.27",
      decision: "Move on.",
      tree: "Prism",
      supersedes: "4",
      requires: ["MoreMobs#5", "nowhere"],
      status: "accepted",
      language: "zh-TW",
    });
    expect(inTree.result.path).toBe("Prism/decisions/0005-API-3.27.md");
    const moved = await w.read("Prism/decisions/0005-API-3.27.md");
    expect(moved).toContain("supersedes: 4\n");
    expect(moved).toContain('requires:\n  - "[[MoreMobs/decisions/0005-0.3.1]]"\n  - "nowhere"\n');
    // Superseding a record on a branch keeps the branch; the folder already names the tree.
    expect(moved).toContain('branch: "4.x"\n');
    expect(moved).not.toContain("tree:");
    expect(moved).toContain("## 決定\nMove on.\n");

    // A tree with no folder yet gets decisions/<tree>/; numbering starts at 1.
    const fresh = await w.tool("record_decision", {
      title: "Start",
      decision: "Go",
      tree: "Fresh",
    });
    expect(fresh.result.path).toBe("decisions/Fresh/0001-Start.md");
    expect((await w.tool("list_decisions", { tree: "Fresh" })).result.decisions).toHaveLength(1);

    const history = await w.call("get_history", { path: plain.result.path });
    expect(history.commits[0].author).toMatchObject({ kind: "plugin", name: "Decisions" });
    expect(history.commits[0].reasons).toEqual(["Agreed in chat"]);
  });

  it("changes a status in place and keeps the rest of the note", async () => {
    const w = await world();
    const before = await w.read("MoreMobs/decisions/0005-0.3.1.md");
    const r = await w.tool(
      "update_decision_status",
      { id: "MoreMobs#5", status: "accepted" },
      "Reviewed",
    );
    expect(r.result).toMatchObject({
      path: "MoreMobs/decisions/0005-0.3.1.md",
      status: "accepted",
      previous: "proposed",
      changed: true,
    });
    expect(await w.read("MoreMobs/decisions/0005-0.3.1.md")).toBe(
      before.replace("status: proposed", "status: accepted"),
    );
    const again = await w.tool("update_decision_status", { id: "MoreMobs#5", status: "accepted" });
    expect(again.result.changed).toBe(false);
    // By path, and a bare number that only one record has.
    expect(
      (
        await w.tool("update_decision_status", {
          id: "Prism/decisions/0004-API-3.26.md",
          status: "rejected",
        })
      ).result.status,
    ).toBe("rejected");
    expect(
      (await w.tool("update_decision_status", { id: "14", status: "superseded" })).result.path,
    ).toBe("decisions/0014-decision-trees.md");
  });

  it("refuses ambiguous or missing references and bad arguments", async () => {
    const w = await world();
    // 0005 exists in decisions/ and MoreMobs/decisions/, but a bare number prefers the top folder.
    expect(
      (await w.tool("update_decision_status", { id: "5", status: "accepted" })).result.path,
    ).toBe("decisions/0005-history-and-decisions.md");
    const gone = await w.tool("update_decision_status", { id: "Nothing#9", status: "accepted" });
    expect(gone.error.message).toContain("not_found");
    expect((await w.tool("update_decision_status", { id: "5", status: "done" })).error.code).toBe(
      "invalid_request",
    );
    // Not a numbered record.
    expect(
      (await w.tool("update_decision_status", { id: "decisions/README.md", status: "accepted" }))
        .error.message,
    ).toContain("not_found");
    expect(
      (await w.tool("record_decision", { title: "   ", decision: "x" })).error.message,
    ).toContain("invalid_argument");
    // A write needs a reason like every change.
    expect(
      (
        await w.call("call_tool", {
          name: "decisions.record_decision",
          arguments: { title: "x", decision: "y" },
        })
      ).error.code,
    ).toBe("invalid_request");
  });

  it("starts from an empty vault and never touches files outside decisions folders", async () => {
    const w = await world(false);
    await server.services.vaults.writeFile("a", "notes/0001-not-a-decision.md", "# nope");
    expect((await w.tool("list_decisions")).result.decisions).toEqual([]);
    const first = await w.tool("record_decision", { title: "First", decision: "Yes" });
    expect(first.result.path).toBe("decisions/0001-First.md");
    expect(
      (
        await w.tool("update_decision_status", {
          id: "notes/0001-not-a-decision.md",
          status: "accepted",
        })
      ).error.message,
    ).toContain("not_found");
    expect(await w.read("notes/0001-not-a-decision.md")).toBe("# nope");
  });

  it("numbers records filed at the same time without overwriting any", async () => {
    const w = await world(false);
    const results = await Promise.all(
      ["A", "B", "C"].map((t) => w.tool("record_decision", { title: `Same ${t}`, decision: t })),
    );
    const paths = results.map((r) => r.result.path).sort();
    expect(new Set(paths).size).toBe(3);
    const { decisions } = (await w.tool("list_decisions")).result;
    expect(decisions).toHaveLength(3);
  });

  it("reads at most the budget of records and says so", async () => {
    const w = await world(false);
    for (let i = 1; i <= 160; i++)
      await server.services.vaults.writeFile(
        "a",
        `decisions/${String(i).padStart(4, "0")}-r.md`,
        `---\nstatus: accepted\n---\n# ${i} r\n`,
      );
    const r = (await w.tool("list_decisions")).result;
    expect(r).toMatchObject({ total: 160, truncated: true });
    expect(r.decisions).toHaveLength(150);
    // Recording still works: it only needs the file names.
    expect((await w.tool("record_decision", { title: "Next", decision: "x" })).result.number).toBe(
      161,
    );
  });
});
