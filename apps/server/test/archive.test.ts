import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness.ts";

/** Reads a stored/deflated ZIP back using the central directory, without any library. */
async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  const { inflateRawSync } = await import("node:zlib");
  const out = new Map<string, Buffer>();
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(at + 10);
    const packed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(data.length).toBe(size);
    out.set(name, data);
    at += 46 + nameLength + extra;
  }
  return out;
}

describe("folder archive", () => {
  let server: TestServer;
  const big = "line of text\n".repeat(200_000);
  beforeAll(async () => {
    server = await startTestServer();
    await server.fetch("/api/vaults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "notes" }),
    });
    const put = (p: string, content: string) =>
      server.fetch(`/api/vaults/notes/files/${p.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
    await put("Projects/Plan.md", "# Plan\n");
    await put("Projects/日本語.md", "こんにちは");
    await put("Projects/big.txt", big);
    await put("Root.md", "root");
    await server.fetch("/api/vaults/notes/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "Projects/Empty" }),
    });
  });
  afterAll(() => server.dispose());

  it("zips a folder with its files, names and empty subfolders", async () => {
    const res = await server.fetch("/api/vaults/notes/archive?path=Projects");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("Projects.zip");
    const files = await unzip(Buffer.from(await res.arrayBuffer()));
    expect(files.get("Projects/Plan.md")?.toString()).toBe("# Plan\n");
    expect(files.get("Projects/日本語.md")?.toString()).toBe("こんにちは");
    expect(files.get("Projects/big.txt")?.toString()).toBe(big);
    expect(files.has("Projects/Empty/")).toBe(true);
    expect(files.has("Root.md")).toBe(false);
  });

  it("zips the whole vault when no path is given", async () => {
    const res = await server.fetch("/api/vaults/notes/archive");
    const files = await unzip(Buffer.from(await res.arrayBuffer()));
    expect(files.get("notes/Root.md")?.toString()).toBe("root");
    expect(files.get("notes/Projects/Plan.md")).toBeDefined();
  });

  it("is a valid archive for a real unzip tool", async () => {
    let tool = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      tool = false;
    }
    if (!tool) return;
    const res = await server.fetch("/api/vaults/notes/archive?path=Projects");
    const dir = await mkdtemp(path.join(tmpdir(), "palimvo-zip-"));
    try {
      const file = path.join(dir, "a.zip");
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      await mkdir(path.join(dir, "out"));
      execFileSync("unzip", ["-tq", file]); // throws on a bad checksum or structure
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing folders and bad paths", async () => {
    expect((await server.fetch("/api/vaults/notes/archive?path=Nope")).status).toBe(404);
    expect((await server.fetch("/api/vaults/notes/archive?path=../x")).status).toBe(400);
    expect((await server.fetch("/api/vaults/ghost/archive")).status).toBe(404);
    expect((await server.fetch("/api/vaults/notes/archive?path=.palimvo")).status).toBe(400);
  });
});
