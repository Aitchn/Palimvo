import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import path from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});
afterEach(() => server.dispose());

const json = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const post = (p: string, body: unknown) => server.fetch(p, { method: "POST", ...json(body) });
const put = (p: string, body: unknown) => server.fetch(p, { method: "PUT", ...json(body) });

async function createVault(id = "demo") {
  const res = await post("/api/vaults", { id });
  expect(res.status).toBe(201);
}

describe("vaults", () => {
  it("creates, lists, removes and restores vaults", async () => {
    await createVault("notes");
    await createVault("work");
    expect(await (await server.fetch("/api/vaults")).json()).toEqual({
      vaults: [
        { id: "notes", name: "notes" },
        { id: "work", name: "work" },
      ],
    });
    await access(path.join(server.dataDir, "vaults", "notes", ".palimvo", "config.json"));

    const removed = (await (
      await server.fetch("/api/vaults/notes", { method: "DELETE" })
    ).json()) as { name: string };
    expect((await (await server.fetch("/api/vaults")).json()) as object).toEqual({
      vaults: [{ id: "work", name: "work" }],
    });
    expect(
      ((await (await server.fetch("/api/removed-vaults")).json()) as { removed: unknown[] })
        .removed,
    ).toHaveLength(1);
    expect((await server.fetch("/api/vaults/notes/files")).status).toBe(404);

    const restored = await server.fetch(`/api/removed-vaults/${removed.name}/restore`, {
      method: "POST",
    });
    expect(await restored.json()).toEqual({ id: "notes" });
    expect((await server.fetch("/api/vaults/notes/files")).status).toBe(200);
  });

  it("answers errors as {code, message}", async () => {
    const dup = await post("/api/vaults", { id: "x" }).then(() => post("/api/vaults", { id: "x" }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: "already_exists" });
    const bad = await post("/api/vaults", { id: 5 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_request" });
    const notJson = await server.fetch("/api/vaults", { method: "POST", body: "nope" });
    expect(notJson.status).toBe(400);
    expect((await server.fetch("/api/vaults/missing/files/a.md")).status).toBe(404);
  });
});

describe("files", () => {
  beforeEach(() => createVault());

  it("writes, reads and deletes a note whose name needs URL encoding", async () => {
    const url =
      "/api/vaults/demo/files/" + ["專案", "my note #1.md"].map(encodeURIComponent).join("/");
    const written = await put(url, { content: "# 你好\n", baseVersion: null });
    expect(written.status).toBe(200);
    const { version, path: filePath } = (await written.json()) as { version: string; path: string };
    expect(filePath).toBe("專案/my note #1.md");

    const read = await server.fetch(url);
    expect(read.headers.get("etag")).toBe(`"${version}"`);
    expect(await read.json()).toMatchObject({ path: filePath, content: "# 你好\n", version });
    expect((await server.fetch(url, { headers: { "if-none-match": `"${version}"` } })).status).toBe(
      304,
    );

    expect((await server.fetch(url, { method: "DELETE" })).status).toBe(204);
    expect((await server.fetch(url)).status).toBe(404);
  });

  it("answers 409 with the latest content when the base version is stale", async () => {
    const url = "/api/vaults/demo/files/a.md";
    const first = (await (await put(url, { content: "one", baseVersion: null })).json()) as {
      version: string;
    };
    await put(url, { content: "two", baseVersion: first.version });
    const stale = await put(url, { content: "three", baseVersion: first.version });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "version_conflict",
      details: { path: "a.md", current: { content: "two" } },
    });
  });

  it("refuses paths that escape the vault, even percent-encoded", async () => {
    for (const bad of ["..%2Fx.md", "a%2F..%2F..%2Fx.md", ".palimvo/config.json"]) {
      const res = await put(`/api/vaults/demo/files/${bad}`, { content: "x" });
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_path" });
    }
    // Dot segments are resolved before the request reaches a route, so it never names a file.
    expect(
      (await put("/api/vaults/demo/files/%2E%2E/x.md", { content: "x" })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await server.fetch("/api/vaults/demo/files/.git/config")).status).toBe(400);
  });

  it("serves the file tree with an ETag that only changes with the file list", async () => {
    const first = await server.fetch("/api/vaults/demo/files");
    const tag = first.headers.get("etag")!;
    expect(((await first.json()) as { tree: { path: string }[] }).tree.map((n) => n.path)).toEqual([
      "Welcome.md",
    ]);
    const same = await server.fetch("/api/vaults/demo/files", {
      headers: { "if-none-match": tag },
    });
    expect(same.status).toBe(304);

    await put("/api/vaults/demo/files/Welcome.md", { content: "edited" });
    expect(
      (await server.fetch("/api/vaults/demo/files", { headers: { "if-none-match": tag } })).status,
    ).toBe(304);
    await put("/api/vaults/demo/files/new.md", { content: "x" });
    const changed = await server.fetch("/api/vaults/demo/files", {
      headers: { "if-none-match": tag },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);
  });

  it("creates folders, moves files and writes batches", async () => {
    expect((await post("/api/vaults/demo/folders", { path: "projects/alpha" })).status).toBe(201);
    await put("/api/vaults/demo/files/n.md", { content: "n" });
    const moved = await post("/api/vaults/demo/move", { from: "n.md", to: "projects/alpha/n.md" });
    expect(await moved.json()).toEqual({ path: "projects/alpha/n.md" });
    expect(
      (await post("/api/vaults/demo/move", { from: "projects", to: "projects/alpha/in.md" }))
        .status,
    ).toBe(400);

    const batch = await post("/api/vaults/demo/batch", {
      writes: [
        { path: "b1.md", baseVersion: null, content: "1" },
        { path: "b2.md", baseVersion: null, content: "2" },
      ],
    });
    expect(batch.status).toBe(200);
    expect(((await batch.json()) as { files: unknown[] }).files).toHaveLength(2);
    const clash = await post("/api/vaults/demo/batch", {
      writes: [
        { path: "b3.md", baseVersion: null, content: "3" },
        { path: "b1.md", baseVersion: null, content: "again" },
      ],
    });
    expect(clash.status).toBe(409);
    expect((await server.fetch("/api/vaults/demo/files/b3.md")).status).toBe(404);
  });

  it("rejects file types it cannot store as text", async () => {
    const res = await put("/api/vaults/demo/files/pic.png", { content: "x" });
    expect(res.status).toBe(415);
  });
});
