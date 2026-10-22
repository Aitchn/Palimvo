import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors.ts";
import { uploadFile } from "./uploads.ts";
import * as put from "./putBytes.ts";
import { mockRoutes } from "../test/render.tsx";

const MiB = 1024 * 1024;
const file = (size: number) => new Blob([new Uint8Array(size)]);

beforeEach(() => vi.restoreAllMocks());

describe("uploadFile", () => {
  it("sends a small file in one request and reports progress", async () => {
    const calls: string[] = [];
    vi.spyOn(put, "putBytes").mockImplementation(async (url, body, options) => {
      calls.push(url);
      options?.onProgress?.(body.size);
      return { path: "a/b.png", size: body.size, version: "v1" };
    });
    const seen: number[] = [];
    const saved = await uploadFile("my vault", "a/b c.png", file(1000), {
      onProgress: (sent) => seen.push(sent),
    });
    expect(calls).toEqual(["/api/vaults/my%20vault/raw/a/b%20c.png?create=1"]);
    expect(saved.path).toBe("a/b.png");
    expect(seen.at(-1)).toBe(1000);
  });

  it("can replace an existing file when asked", async () => {
    const spy = vi
      .spyOn(put, "putBytes")
      .mockResolvedValue({ path: "x.png", size: 1, version: "v" });
    await uploadFile("v", "x.png", file(1), { create: false });
    expect(spy.mock.calls[0]![0]).toBe("/api/vaults/v/raw/x.png");
  });

  it("builds a big file from parts and finishes it", async () => {
    const big = file(70 * MiB);
    const parts: string[] = [];
    vi.spyOn(put, "putBytes").mockImplementation(async (url, body) => {
      parts.push(`${url} ${body.size}`);
      const offset = Number(new URL(url, "http://x").searchParams.get("offset"));
      return { id: "u1", received: offset + body.size, size: big.size, partBytes: 32 * MiB };
    });
    const { calls } = mockRoutes({
      "POST /api/vaults/v/uploads": () =>
        Response.json({
          id: "u1",
          path: "v.mp4",
          size: big.size,
          received: 0,
          partBytes: 32 * MiB,
        }),
      "POST /api/vaults/v/uploads/u1/finish": () =>
        Response.json({ path: "v.mp4", size: big.size, version: "z" }),
    });
    const saved = await uploadFile("v", "v.mp4", big);
    expect(saved).toEqual({ path: "v.mp4", size: big.size, version: "z" });
    expect(parts).toEqual([
      `/api/vaults/v/uploads/u1?offset=0 ${32 * MiB}`,
      `/api/vaults/v/uploads/u1?offset=${32 * MiB} ${32 * MiB}`,
      `/api/vaults/v/uploads/u1?offset=${64 * MiB} ${6 * MiB}`,
    ]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { path: "v.mp4", size: big.size, create: true },
    });
  });

  it("asks the server where it is after a part fails, and carries on from there", async () => {
    const big = file(70 * MiB);
    let attempt = 0;
    const offsets: number[] = [];
    vi.spyOn(put, "putBytes").mockImplementation(async (url, body) => {
      const offset = Number(new URL(url, "http://x").searchParams.get("offset"));
      offsets.push(offset);
      if (++attempt === 2) throw new ApiError("network", 0, "down");
      return { id: "u1", received: offset + body.size, size: big.size, partBytes: 32 * MiB };
    });
    mockRoutes({
      "POST /api/vaults/v/uploads": () =>
        Response.json({
          id: "u1",
          path: "v.mp4",
          size: big.size,
          received: 0,
          partBytes: 32 * MiB,
        }),
      // The second part never arrived, so the server is still at the end of the first.
      "GET /api/vaults/v/uploads/u1": () =>
        Response.json({
          id: "u1",
          path: "v.mp4",
          size: big.size,
          received: 32 * MiB,
          partBytes: 32 * MiB,
        }),
      "POST /api/vaults/v/uploads/u1/finish": () =>
        Response.json({ path: "v.mp4", size: big.size, version: "z" }),
    });
    await uploadFile("v", "v.mp4", big, { retryDelay: () => 0 });
    expect(offsets).toEqual([0, 32 * MiB, 32 * MiB, 64 * MiB]);
  });

  it("gives up on an answer that is not worth retrying and discards the staged upload", async () => {
    const big = file(70 * MiB);
    vi.spyOn(put, "putBytes").mockRejectedValue(new ApiError("storage_full", 507, "full"));
    const { calls } = mockRoutes({
      "POST /api/vaults/v/uploads": () =>
        Response.json({
          id: "u1",
          path: "v.mp4",
          size: big.size,
          received: 0,
          partBytes: 32 * MiB,
        }),
      "DELETE /api/vaults/v/uploads/u1": () => new Response(null, { status: 204 }),
    });
    await expect(uploadFile("v", "v.mp4", big)).rejects.toMatchObject({ code: "storage_full" });
    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE" }));
  });

  it("refuses a file over 4 GiB before sending anything", async () => {
    const huge = { size: 4 * 1024 * MiB + 1 } as Blob;
    await expect(uploadFile("v", "x.mp4", huge)).rejects.toMatchObject({
      code: "payload_too_large",
    });
  });
});
