import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRange } from "../src/routes/raw.ts";
import { startTestServer, type TestServer } from "./harness.ts";

describe("parseRange", () => {
  it("reads single byte ranges", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
  });
  it("rejects ranges outside the file and ignores what it cannot serve", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=9-3", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
  });
});

describe("raw files", () => {
  let server: TestServer;
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const url = (p: string) =>
    `/api/vaults/media/raw/${p.split("/").map(encodeURIComponent).join("/")}`;

  beforeAll(async () => {
    server = await startTestServer();
    await server.fetch("/api/vaults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "media" }),
    });
    const dir = path.join(server.dataDir, "vaults", "media");
    await mkdir(path.join(dir, "img"), { recursive: true });
    await writeFile(path.join(dir, "img", "cat.png"), bytes);
    await writeFile(path.join(dir, "img", "my clip.mp4"), bytes);
    await writeFile(path.join(dir, "img", "empty.png"), "");
    await writeFile(path.join(dir, "img", "pic.svg"), "<svg onload=alert(1)/>");
    await writeFile(path.join(dir, "data.bin"), bytes);
    await writeFile(path.join(dir, ".palimvo", "secret.png"), bytes).catch(() => undefined);
    await symlink(path.dirname(dir), path.join(dir, "escape")).catch(() => undefined);
  });
  afterAll(() => server.dispose());

  it("serves the bytes with their type and safe headers", async () => {
    const res = await server.fetch(url("img/cat.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("finds names with spaces and serves SVG as text, never as an image document", async () => {
    expect((await server.fetch(url("img/my clip.mp4"))).headers.get("content-type")).toBe(
      "video/mp4",
    );
    const svg = await server.fetch(url("img/pic.svg"));
    expect(svg.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("sends unknown types as a download", async () => {
    const res = await server.fetch(url("data.bin"));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("answers byte ranges with 206 and rejects bad ones with 416", async () => {
    const part = await server.fetch(url("img/my clip.mp4"), { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/256");
    expect(part.headers.get("content-length")).toBe("10");
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);

    const tail = await server.fetch(url("img/cat.png"), { headers: { range: "bytes=-4" } });
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(252))).toBe(true);

    const bad = await server.fetch(url("img/cat.png"), { headers: { range: "bytes=300-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */256");
  });

  it("ignores a range when If-Range names another version", async () => {
    const res = await server.fetch(url("img/cat.png"), {
      headers: { range: "bytes=0-3", "if-range": '"old"' },
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(256);
  });

  it("revalidates with ETag", async () => {
    const first = await server.fetch(url("img/cat.png"));
    const tag = first.headers.get("etag")!;
    await first.arrayBuffer();
    const again = await server.fetch(url("img/cat.png"), { headers: { "if-none-match": tag } });
    expect(again.status).toBe(304);
  });

  it("serves an empty file", async () => {
    const res = await server.fetch(url("img/empty.png"));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("does not leak anything outside the vault's files", async () => {
    expect((await server.fetch(url("missing.png"))).status).toBe(404);
    expect((await server.fetch(url("img"))).status).toBe(404);
    expect((await server.fetch(url(".palimvo/config.json"))).status).toBe(400);
    expect((await server.fetch("/api/vaults/media/raw/..%2F..%2Fpalimvo.db")).status).toBe(400);
    expect((await server.fetch(url("escape/palimvo.db"))).status).toBe(404);
  });
});

describe("raw files in a vault called raw", () => {
  it("takes the path after the route, not after the first /raw/", async () => {
    const server = await startTestServer();
    try {
      await server.fetch("/api/vaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "raw" }),
      });
      const dir = path.join(server.dataDir, "vaults", "raw");
      await mkdir(path.join(dir, "raw"), { recursive: true });
      await writeFile(path.join(dir, "img.png"), "root");
      await writeFile(path.join(dir, "raw", "img.png"), "nested");
      expect(await (await server.fetch("/api/vaults/raw/raw/img.png")).text()).toBe("root");
      expect(await (await server.fetch("/api/vaults/raw/raw/raw/img.png")).text()).toBe("nested");
    } finally {
      await server.dispose();
    }
  });
});
