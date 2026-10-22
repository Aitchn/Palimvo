import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
  const res = await server.fetch("/api/vaults", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "v" }),
  });
  expect(res.status).toBe(201);
});
afterEach(() => server.dispose());

const V = "/api/vaults/v";
const MiB = 1024 * 1024;
const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
// Responses are poked at freely; their shape is checked by the assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const asJson = async (res: Response) => (await res.json()) as Json;

/** Deterministic bytes, so a 100 MiB file can be rebuilt and compared without keeping it around. */
function pattern(length: number, seed = 1): Buffer {
  const out = Buffer.allocUnsafe(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >> 16;
  }
  return out;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const onDisk = (rel: string) => path.join(server.dataDir, "vaults", "v", ...rel.split("/"));

/** Sends a whole file through the resumable routes under `base` (a signed-in upload or a link). */
async function sendInParts(base: string, bytes: Buffer, partBytes: number, started: Json) {
  let off = started.received as number;
  while (off < bytes.length) {
    const piece = bytes.subarray(off, Math.min(bytes.length, off + partBytes));
    const res = await server.fetch(`${base}?offset=${off}`, { method: "PUT", body: piece });
    expect(res.status, await res.clone().text()).toBe(200);
    off = (await asJson(res)).received;
  }
}

describe("one-request upload", () => {
  it("stores a file, refuses to replace it unless asked, and keeps notes out", async () => {
    const bytes = pattern(5000);
    const put = (p: string, query = "") =>
      server.fetch(`${V}/raw/${p}${query}`, { method: "PUT", body: bytes });
    const made = await put("assets/pic.png", "?create=1");
    expect(made.status).toBe(201);
    expect(await asJson(made)).toMatchObject({ path: "assets/pic.png", size: 5000 });
    expect(sha(await readFile(onDisk("assets/pic.png")))).toBe(sha(bytes));

    const again = await put("assets/pic.png", "?create=1");
    expect(again.status).toBe(409);
    expect((await asJson(again)).code).toBe("already_exists");
    expect((await put("assets/pic.png")).status).toBe(201); // replacing is allowed without create

    expect((await asJson(await put("n.md"))).code).toBe("invalid_request");
    const weird = await put("data.weird");
    expect(weird.status).toBe(415);
    expect((await asJson(weird)).code).toBe("unsupported_type");
    expect((await asJson(await put(".palimvo/x.png"))).code).toBe("invalid_path");
  });

  it("refuses a body over the single-request limit", async () => {
    const res = await server.fetch(`${V}/raw/huge.mp4`, {
      method: "PUT",
      body: Buffer.alloc(64 * MiB + 1),
    });
    expect(res.status).toBe(413);
    expect((await asJson(res)).code).toBe("payload_too_large");
  });

  it("tells clients what the vault accepts", async () => {
    const types = await asJson(await server.fetch(`${V}/file-types`));
    expect(types).toMatchObject({
      maxBytes: 64 * MiB,
      maxBytesChunked: 4096 * MiB,
      partBytes: 32 * MiB,
      plugins: [],
    });
  });

  it("credits the uploader in the history", async () => {
    await server.fetch(`${V}/raw/a.png`, {
      method: "PUT",
      headers: { "x-palimvo-author": "ai:Claude Code", "x-palimvo-reason": "logo" },
      body: pattern(10),
    });
    await server.services.history.flushAll();
    const log = await asJson(await server.fetch(`${V}/history?path=a.png`));
    expect(JSON.stringify(log.commits[0])).toContain("Claude Code");
  });
});

describe("resumable upload", () => {
  const begin = async (body: unknown) => server.fetch(`${V}/uploads`, jsonInit("POST", body));

  it("builds a 100 MiB file from parts and records one change", async () => {
    const bytes = pattern(100 * MiB, 7);
    const started = await asJson(await begin({ path: "video/big.mp4", size: bytes.length }));
    expect(started).toMatchObject({ size: bytes.length, received: 0, partBytes: 32 * MiB });
    await sendInParts(`${V}/uploads/${started.id}`, bytes, started.partBytes, started);

    const done = await server.fetch(`${V}/uploads/${started.id}/finish`, { method: "POST" });
    expect(done.status).toBe(201);
    expect(await asJson(done)).toMatchObject({ path: "video/big.mp4", size: bytes.length });
    expect(sha(await readFile(onDisk("video/big.mp4")))).toBe(sha(bytes));
    // The staging folder is gone, and the upload cannot be finished twice.
    expect(await readdir(onDisk(".palimvo/uploads"))).toEqual([]);
    expect(
      (await server.fetch(`${V}/uploads/${started.id}/finish`, { method: "POST" })).status,
    ).toBe(404);
  }, 120_000);

  it("carries on from where the server says after a broken part", async () => {
    const bytes = pattern(3 * MiB, 3);
    const started = await asJson(await begin({ path: "a.mp3", size: bytes.length }));
    const url = `${V}/uploads/${started.id}`;
    const first = await asJson(
      await server.fetch(`${url}?offset=0`, { method: "PUT", body: bytes.subarray(0, MiB) }),
    );
    expect(first.received).toBe(MiB);

    const wrong = await server.fetch(`${url}?offset=0`, {
      method: "PUT",
      body: bytes.subarray(0, 10),
    });
    expect(wrong.status).toBe(409);
    expect(await asJson(wrong)).toMatchObject({
      code: "upload_offset",
      details: { expected: MiB, got: 0 },
    });
    expect((await asJson(await server.fetch(url))).received).toBe(MiB);

    const early = await server.fetch(`${url}/finish`, { method: "POST" });
    expect(early.status).toBe(409);
    expect((await asJson(early)).code).toBe("upload_incomplete");

    await sendInParts(url, bytes, 2 * MiB, { received: MiB });
    expect((await server.fetch(`${url}/finish`, { method: "POST" })).status).toBe(201);
    expect(sha(await readFile(onDisk("a.mp3")))).toBe(sha(bytes));
  });

  it("rejects a part that goes past the end, a bad type and a taken name", async () => {
    const started = await asJson(await begin({ path: "short.wav", size: 4 }));
    const over = await server.fetch(`${V}/uploads/${started.id}?offset=0`, {
      method: "PUT",
      body: Buffer.alloc(5),
    });
    expect(over.status).toBe(413);
    expect((await asJson(await begin({ path: "x.weird", size: 4 }))).code).toBe("unsupported_type");
    expect((await asJson(await begin({ path: "x.mp4", size: 5 * 1024 * MiB }))).code).toBe(
      "payload_too_large",
    );
    await server.fetch(`${V}/raw/taken.png`, { method: "PUT", body: pattern(3) });
    expect((await begin({ path: "taken.png", size: 3, create: true })).status).toBe(409);
  });

  it("cancels an upload and limits unfinished ones per vault", async () => {
    const first = await asJson(await begin({ path: "one.mp4", size: 10 }));
    expect((await server.fetch(`${V}/uploads/${first.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await server.fetch(`${V}/uploads/${first.id}`)).status).toBe(404);
    expect((await server.fetch(`${V}/uploads/not-an-id`)).status).toBe(404);

    for (let i = 0; i < 20; i++)
      expect((await begin({ path: `f${i}.mp4`, size: 1 })).status).toBe(201);
    const over = await begin({ path: "f20.mp4", size: 1 });
    expect(over.status).toBe(409);
    expect((await asJson(over)).code).toBe("upload_limit");
  });
});

describe("upload links", () => {
  async function makeLink(body: unknown = { path: "drop/clip.mp4" }) {
    const res = await server.fetch(`${V}/upload-links`, jsonInit("POST", body));
    expect(res.status, await res.clone().text()).toBe(201);
    const link = await asJson(res);
    return { ...link, base: new URL(link.url).pathname } as {
      url: string;
      base: string;
      commands: Json;
      path: string;
    };
  }

  it("uploads one file without signing in, then stops working", async () => {
    const link = await makeLink();
    expect(link.url).toMatch(/\/api\/upload-links\/[a-f0-9]{64}$/);
    expect(link.commands.bash).toContain(`${link.url}/upload.sh`);
    expect(link.commands.powershell).toContain(`${link.url}/upload.ps1`);

    const info = await asJson(await server.fetch(link.base));
    expect(info).toMatchObject({ path: "drop/clip.mp4", partBytes: 32 * MiB });

    const bytes = pattern(2 * MiB + 17, 9);
    const started = await asJson(
      await server.fetch(`${link.base}/begin`, jsonInit("POST", { size: bytes.length })),
    );
    // Beginning again with the same size picks up the same upload.
    expect(
      (
        await asJson(
          await server.fetch(`${link.base}/begin`, jsonInit("POST", { size: bytes.length })),
        )
      ).id,
    ).toBe(started.id);
    await sendInParts(`${link.base}/parts`, bytes, MiB, started);
    expect(await asJson(await server.fetch(link.base))).toMatchObject({ received: bytes.length });

    const done = await server.fetch(`${link.base}/finish`, { method: "POST" });
    expect(done.status).toBe(201);
    expect(await asJson(done)).toMatchObject({ path: "drop/clip.mp4", size: bytes.length });
    expect(sha(await readFile(onDisk("drop/clip.mp4")))).toBe(sha(bytes));
    expect((await server.fetch(link.base)).status).toBe(404);
    expect((await server.fetch(`${link.base}/begin`, jsonInit("POST", { size: 1 }))).status).toBe(
      404,
    );
  });

  it("serves the upload page and the command scripts with the link filled in", async () => {
    const link = await makeLink();
    const page = await server.fetch(link.base, { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'nonce-/);
    expect(await page.text()).toContain("drop/clip.mp4");

    const sh = await (await server.fetch(`${link.base}/upload.sh`)).text();
    expect(sh).toContain(`u='${link.url}'`);
    const ps = await (await server.fetch(`${link.base}/upload.ps1`)).text();
    expect(ps).toContain(`$u = '${link.url}'`);

    const gone = await server.fetch(`/api/upload-links/${"0".repeat(64)}`, {
      headers: { accept: "text/html" },
    });
    expect(gone.status).toBe(404);
    expect(gone.headers.get("content-type")).toMatch(/html/);
    expect((await server.fetch("/api/upload-links/short")).status).toBe(404);
  });

  it("refuses links for notes, unknown types and files that already exist", async () => {
    const bad = (body: unknown) => server.fetch(`${V}/upload-links`, jsonInit("POST", body));
    expect((await bad({ path: "n.md" })).status).toBe(400);
    expect((await bad({ path: "x.weird" })).status).toBe(415);
    await server.fetch(`${V}/raw/there.png`, { method: "PUT", body: pattern(3) });
    expect((await bad({ path: "there.png" })).status).toBe(409);
    expect((await bad({ path: "there.png", create: false })).status).toBe(201);
  });

  it("needs the whole file before it saves, and the staged bytes stay out of the vault", async () => {
    const link = await makeLink({ path: "later.mp3" });
    expect((await server.fetch(`${link.base}/finish`, { method: "POST" })).status).toBe(400);
    await server.fetch(`${link.base}/begin`, jsonInit("POST", { size: 100 }));
    expect((await server.fetch(`${link.base}/finish`, { method: "POST" })).status).toBe(409);
    await expect(stat(onDisk("later.mp3"))).rejects.toThrow();
  });
});

// The shell script is the part of a link a program runs; check it with a real curl where there is one.
const hasShell = spawnSync("sh", ["-c", "command -v curl dd wc"]).status === 0;
describe.skipIf(!hasShell || process.platform === "win32")("upload.sh", () => {
  it("uploads a file through a link and prints the saved path", async () => {
    const res = await server.fetch(
      `${V}/upload-links`,
      jsonInit("POST", { path: "scripted/data.mp3" }),
    );
    const link = await asJson(res);
    const script = await (await server.fetch(`${new URL(link.url).pathname}/upload.sh`)).text();
    const dir = await mkdtemp(path.join(tmpdir(), "palimvo-sh-"));
    try {
      const file = path.join(dir, "in.bin");
      const bytes = pattern(3 * MiB + 5, 11);
      await writeFile(file, bytes);
      await writeFile(path.join(dir, "upload.sh"), script);
      const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
        const child = spawn("sh", [path.join(dir, "upload.sh"), file]);
        let text = "";
        child.stdout.on("data", (d: Buffer) => (text += d.toString()));
        child.stderr.on("data", (d: Buffer) => (text += d.toString()));
        child.on("close", (code) => resolve({ code, text }));
      });
      expect(out.code, out.text).toBe(0);
      expect(out.text).toContain('"path":"scripted/data.mp3"');
      expect(sha(await readFile(onDisk("scripted/data.mp3")))).toBe(sha(bytes));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
