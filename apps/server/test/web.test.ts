import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness.ts";

describe("built web app", () => {
  let server: TestServer;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "palimvo-web-"));
    await mkdir(path.join(dir, "assets"));
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>app</title>");
    await writeFile(path.join(dir, "assets", "app-abc123.js"), "console.log(1)");
    await writeFile(path.join(dir, "secret.txt"), "outside");
    server = await startTestServer({ webDir: path.join(dir, ".") });
  });
  afterAll(async () => {
    await server.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves index.html at the root and for deep links", async () => {
    for (const p of ["/", "/v/notes/Projects/Plan.md", "/v/%E7%AD%86%E8%A8%98"]) {
      const res = await server.fetch(p, {
        headers: { accept: "text/html", "accept-encoding": "identity" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<title>app</title>");
    }
  });

  it("caches hashed assets for good and revalidates with ETag", async () => {
    const res = await server.fetch("/assets/app-abc123.js");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("content-type")).toContain("javascript");
    const tag = res.headers.get("etag")!;
    const again = await server.fetch("/assets/app-abc123.js", {
      headers: { "if-none-match": tag },
    });
    expect(again.status).toBe(304);
  });

  it("does not turn API misses or missing files into the app", async () => {
    for (const p of ["/api/nope", "/mcp", "/oauth/x", "/assets/missing.js", "/missing.png"]) {
      const res = await server.fetch(p);
      expect(res.status, p).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("stays inside the folder", async () => {
    const res = await server.fetch("/..%2Fsecret.txt");
    expect(await res.text()).not.toContain("outside");
  });

  it("refuses to start when the configured folder has no index.html", async () => {
    await expect(startTestServer({ webDir: path.join(dir, "assets") })).rejects.toThrow(
      /PALIMVO_WEB_DIR/,
    );
  });
});
