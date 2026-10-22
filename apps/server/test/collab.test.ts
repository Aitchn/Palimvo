import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyContent, markdownText, readCanvas } from "@palimvo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;
const providers: WebsocketProvider[] = [];

beforeEach(async () => {
  server = await startTestServer();
  expect((await post("/api/vaults", { id: "demo" })).status).toBe(201);
});
afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy();
  await server.dispose();
});

const json = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const post = (p: string, body: unknown) => server.fetch(p, { method: "POST", ...json(body) });
const put = (file: string, body: unknown, headers: Record<string, string> = {}) =>
  server.fetch(`/api/vaults/demo/files/${file}`, {
    method: "PUT",
    ...json(body),
    headers: { "content-type": "application/json", ...headers },
  });
const get = async (file: string) =>
  (await (await server.fetch(`/api/vaults/demo/files/${file}`)).json()) as {
    content: string;
    version: string;
  };

const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const disk = (file: string) => readFile(path.join(server.dataDir, "vaults", "demo", file), "utf8");

function provide(doc: Y.Doc, vault: string, file: string, params: Record<string, string> = {}) {
  const provider = new WebsocketProvider(
    `${server.url.replace("http", "ws")}/api/collab`,
    encodeURIComponent(`${vault}/${file}`),
    doc,
    {
      WebSocketPolyfill: WebSocket as never,
      params: { vault, path: file, ...params },
      disableBc: true,
    },
  );
  providers.push(provider);
  return provider;
}

async function connect(file: string, name = "Tester") {
  const doc = new Y.Doc();
  const provider = provide(doc, "demo", file);
  provider.awareness.setLocalStateField("user", { name, color: "#e05252" });
  await until(() => provider.synced);
  return { doc, provider, text: markdownText(doc) };
}

describe("live collaboration", () => {
  it("merges two browsers and an API write into one document and saves it", async () => {
    await put("n.md", { content: "one\ntwo\n" });
    const a = await connect("n.md");
    const b = await connect("n.md");
    a.text.insert(0, "A: ");
    b.text.insert(b.text.length, "B was here\n");
    await until(() => a.text.toString() === b.text.toString() && a.text.length > 12);

    // The AI read the note before the people typed; its edit lands in the same document.
    const seen = await get("n.md");
    const ai = await put(
      "n.md",
      { content: seen.content.replace("two", "TWO (AI)"), baseVersion: seen.version },
      { "x-palimvo-author": "ai:Claude%20Code" },
    );
    expect(ai.status).toBe(200);

    const expected = "A: one\nTWO (AI)\nB was here\n";
    await until(() => a.text.toString() === expected && b.text.toString() === expected);
    await until(async () => (await disk("n.md")) === expected);
    expect((await get("n.md")).content).toBe(expected);
  });

  it("merges an API write that is based on an older version into what people typed since", async () => {
    await put("n.md", { content: "line one\nline two\n" });
    const a = await connect("n.md");
    a.text.insert(a.text.length, "typed by a person\n");
    await until(async () => (await get("n.md")).content.includes("typed by a person"));
    const current = await get("n.md");
    const res = await put("n.md", {
      content: current.content.replace("line one", "LINE ONE (AI)"),
      baseVersion: current.version,
    });
    expect(res.status).toBe(200);
    await until(() => a.text.toString() === "LINE ONE (AI)\nline two\ntyped by a person\n");
  });

  it("rejects an API write based on a version the live document has moved past", async () => {
    await put("n.md", { content: "v1" });
    const before = await get("n.md");
    const a = await connect("n.md");
    a.text.insert(2, " edited");
    await until(async () => (await get("n.md")).content === "v1 edited");
    const res = await put("n.md", { content: "stale", baseVersion: before.version });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; details: { current: { content: string } } };
    expect(body.code).toBe("version_conflict");
    expect(body.details.current.content).toBe("v1 edited");
  });

  it("credits the writers in the history, one commit per author", async () => {
    await put("n.md", { content: "base\n" }, { "x-palimvo-author": "ai:Claude" });
    const a = await connect("n.md", "Dana");
    a.text.insert(0, "Dana: ");
    await until(async () => (await disk("n.md")) === "Dana: base\n");
    await server.services.collab.flushAll();
    await server.services.history.flushAll();
    const { commits } = (await (
      await server.fetch("/api/vaults/demo/history?path=n.md")
    ).json()) as {
      commits: { author: { name: string } }[];
    };
    expect(commits.map((c) => c.author.name)).toEqual(expect.arrayContaining(["Dana"]));
  });

  it("picks up edits made directly on disk while idle", async () => {
    await put("n.md", { content: "original" });
    const a = await connect("n.md");
    await writeFile(path.join(server.dataDir, "vaults", "demo", "n.md"), "changed elsewhere");
    await until(() => a.text.toString() === "changed elsewhere");
  });

  it("keeps both versions when a disk edit races unsaved live edits", async () => {
    await put("n.md", { content: "base" });
    const a = await connect("n.md");
    await writeFile(path.join(server.dataDir, "vaults", "demo", "n.md"), "theirs");
    a.text.insert(4, " + ours");
    await until(async () => (await disk("n.md")).endsWith("+ ours"));
    const files = await readdir(path.join(server.dataDir, "vaults", "demo"));
    // Whichever side won the race, nothing was lost: the other text survives in the file or a conflict copy.
    const names = files.filter((f) => f.startsWith("n (conflict"));
    const content = await disk("n.md");
    if (content === "base + ours") expect(names).toHaveLength(1);
    else expect(content).toBe("theirs + ours");
  });

  it("closes editors of a deleted file and does not recreate it", async () => {
    await put("n.md", { content: "x" });
    const a = await connect("n.md");
    const closed = new Promise<number>((resolve) =>
      a.provider.on("connection-close", (e: CloseEvent | null) => resolve(e?.code ?? 0)),
    );
    a.text.insert(1, "y");
    expect((await server.fetch("/api/vaults/demo/files/n.md", { method: "DELETE" })).status).toBe(
      204,
    );
    expect(await closed).toBe(4404);
    await new Promise((r) => setTimeout(r, 200));
    expect((await server.fetch("/api/vaults/demo/files/n.md")).status).toBe(404);
  });

  it("writes unsaved edits before a move and closes the old document", async () => {
    await put("old.md", { content: "text" });
    const a = await connect("old.md");
    const closed = new Promise<number>((resolve) =>
      a.provider.on("connection-close", (e: CloseEvent | null) => resolve(e?.code ?? 0)),
    );
    a.text.insert(4, " edited");
    const moved = await post("/api/vaults/demo/move", { from: "old.md", to: "new.md" });
    expect(moved.status).toBe(200);
    expect(await closed).toBe(4404);
    expect(await disk("new.md")).toBe("text edited");
  });

  it("refuses files that do not exist or cannot be edited live", async () => {
    for (const file of ["missing.md", "image.png"]) {
      const provider = provide(new Y.Doc(), "demo", file);
      const code = await new Promise<number>((resolve) =>
        provider.on("connection-close", (e: CloseEvent | null) => resolve(e?.code ?? 0)),
      );
      expect(code).toBe(4404);
    }
  });

  it("refuses a page on another site", async () => {
    const ws = new WebSocket(
      `${server.url.replace("http", "ws")}/api/collab/x?vault=demo&path=Welcome.md`,
      { origin: "https://evil.example" },
    );
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
    });
    expect(status).toBe(403);
  });

  it("merges canvas edits per card and ignores unparsable disk edits", async () => {
    const canvas = {
      nodes: [
        { id: "a", type: "text", text: "A", x: 0, y: 0, width: 100, height: 50 },
        { id: "b", type: "text", text: "B", x: 200, y: 0, width: 100, height: 50 },
      ],
      edges: [],
    };
    await put("c.canvas", { content: JSON.stringify(canvas) });
    const a = await connect("c.canvas");
    const b = await connect("c.canvas");
    const moved = readCanvas(a.doc);
    moved.nodes[0] = { ...moved.nodes[0]!, x: 50 };
    applyContent(a.doc, "canvas", JSON.stringify(moved));
    const edited = readCanvas(b.doc);
    edited.nodes[1] = { ...edited.nodes[1]!, text: "B edited" } as never;
    applyContent(b.doc, "canvas", JSON.stringify(edited));
    await until(
      () =>
        JSON.stringify(readCanvas(a.doc)) === JSON.stringify(readCanvas(b.doc)) &&
        readCanvas(a.doc).nodes[0]!.x === 50,
    );
    expect(readCanvas(a.doc).nodes[1]).toMatchObject({ text: "B edited" });
    await until(async () => JSON.parse(await disk("c.canvas")).nodes[1].text === "B edited");

    await writeFile(path.join(server.dataDir, "vaults", "demo", "c.canvas"), "{broken json");
    await new Promise((r) => setTimeout(r, 200));
    expect(readCanvas(a.doc).nodes).toHaveLength(2);
  });

  it("applies a batch to open documents and holds typing meanwhile", async () => {
    await put("a.md", { content: "A" });
    await put("b.md", { content: "B" });
    const a = await connect("a.md");
    await until(async () => (await get("a.md")).content === "A");
    const before = await get("a.md");
    const bBefore = await get("b.md");
    const res = await post("/api/vaults/demo/batch", {
      writes: [
        { path: "a.md", baseVersion: before.version, content: "A batch" },
        { path: "b.md", baseVersion: bBefore.version, content: "B batch" },
      ],
    });
    expect(res.status).toBe(200);
    await until(() => a.text.toString() === "A batch");
    expect(await disk("b.md")).toBe("B batch");
    // A stale batch fails as a whole.
    const stale = await post("/api/vaults/demo/batch", {
      writes: [
        { path: "a.md", baseVersion: before.version, content: "nope" },
        { path: "b.md", baseVersion: (await get("b.md")).version, content: "nope" },
      ],
    });
    expect(stale.status).toBe(409);
    expect(await disk("b.md")).toBe("B batch");
  });

  it("restores a version into the open document instead of replacing it behind people's backs", async () => {
    await put("n.md", { content: "first\n" });
    await server.services.history.flushAll();
    const a = await connect("n.md");
    a.text.insert(a.text.length, "second\n");
    await until(async () => (await disk("n.md")) === "first\nsecond\n");
    await server.services.history.flushAll();
    const { commits } = (await (
      await server.fetch("/api/vaults/demo/history?path=n.md")
    ).json()) as {
      commits: { id: string }[];
    };
    const oldest = commits.at(-1)!.id;
    const restored = await post("/api/vaults/demo/restore", { path: "n.md", commit: oldest });
    expect(restored.status).toBe(200);
    await until(() => a.text.toString() === "first\n");
  });

  it("saves open documents before a checkpoint", async () => {
    const slow = await startTestServer(
      {},
      { collab: { persistDelayMs: 60_000, persistMaxDelayMs: 60_000 } },
    );
    try {
      await slow.fetch("/api/vaults", { method: "POST", ...json({ id: "demo" }) });
      await slow.fetch("/api/vaults/demo/files/n.md", {
        method: "PUT",
        ...json({ content: "x" }),
      });
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(
        `${slow.url.replace("http", "ws")}/api/collab`,
        "r",
        doc,
        {
          WebSocketPolyfill: WebSocket as never,
          params: { vault: "demo", path: "n.md" },
          disableBc: true,
        },
      );
      providers.push(provider);
      await until(() => provider.synced);
      doc.getText("markdown").insert(1, "y");
      await until(() => slow.services.collab.size === 1);
      await new Promise((r) => setTimeout(r, 100));
      const res = await slow.fetch("/api/vaults/demo/checkpoints", {
        method: "POST",
        ...json({ message: "before lunch" }),
      });
      expect(res.status).toBe(201);
      expect(await readFile(path.join(slow.dataDir, "vaults", "demo", "n.md"), "utf8")).toBe("xy");
    } finally {
      await slow.dispose();
    }
  });

  it("closes open documents when the vault is removed", async () => {
    await put("n.md", { content: "x" });
    const a = await connect("n.md");
    const closed = new Promise<number>((resolve) =>
      a.provider.on("connection-close", (e: CloseEvent | null) => resolve(e?.code ?? 0)),
    );
    a.text.insert(1, "y");
    expect((await server.fetch("/api/vaults/demo", { method: "DELETE" })).status).toBe(200);
    expect(await closed).toBe(4404);
  });

  it("does not put its saved state into the vault's history", async () => {
    await put("n.md", { content: "x" });
    const a = await connect("n.md");
    a.text.insert(1, "y");
    await until(async () => (await disk("n.md")) === "xy");
    await server.services.history.flushAll();
    const { commits } = (await (await server.fetch("/api/vaults/demo/history")).json()) as {
      commits: { files: string[] }[];
    };
    expect(commits.flatMap((c) => c.files).filter((f) => f.includes("collab"))).toEqual([]);
  });
});

describe("restarts", () => {
  it("writes live edits on shutdown, and an editor that reconnects does not duplicate its text", async () => {
    // Saving is slow here, so only the shutdown can have written the typed line.
    await server.dispose();
    const slow = { collab: { persistDelayMs: 60_000, persistMaxDelayMs: 60_000 } };
    server = await startTestServer({}, slow);
    await post("/api/vaults", { id: "demo" });
    await put("n.md", { content: "first line\n" });
    const a = await connect("n.md");
    a.text.insert(a.text.length, "second line\n");
    await until(async () => (await get("n.md")).content.endsWith("second line\n"));
    const dataDir = server.dataDir;
    const port = Number(new URL(server.url).port);
    // Like a restart: the process stops and a new one starts on the same data and port.
    await server.close();
    expect(await readFile(path.join(dataDir, "vaults", "demo", "n.md"), "utf8")).toBe(
      "first line\nsecond line\n",
    );
    server = await startTestServer({ dataDir, port });
    await until(() => a.provider.synced && a.provider.wsconnected, 8000);
    await new Promise((r) => setTimeout(r, 200));
    expect(a.text.toString()).toBe("first line\nsecond line\n");
  });

  it("turns away an editor whose copy belongs to an older history instead of merging it", async () => {
    await put("n.md", { content: "text\n" });
    const a = await connect("n.md");
    const lineage = a.doc.getMap("collab.meta").get("lineage") as string;
    expect(lineage).toBeTruthy();
    await server.services.collab.flushAll();
    await server.services.collab.closeAll();
    // The file changes while nobody has it open, so the saved history no longer applies.
    await writeFile(path.join(server.dataDir, "vaults", "demo", "n.md"), "rewritten elsewhere\n");

    const stale = provide(new Y.Doc(), "demo", "n.md", { lineage });
    const codes: number[] = [];
    stale.on("connection-close", (event: { code: number } | null) => {
      if (event) codes.push(event.code);
    });
    await until(() => codes.includes(4409));
    expect(await disk("n.md")).toBe("rewritten elsewhere\n");

    const fresh = await connect("n.md");
    expect(fresh.text.toString()).toBe("rewritten elsewhere\n");
    expect(fresh.doc.getMap("collab.meta").get("lineage")).not.toBe(lineage);
  });
});
