import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/index.ts";
import { mockFetch } from "../test/render.tsx";
import { encodePath, request } from "./client.ts";
import { ApiError, describeError } from "./errors.ts";
import { readFile, writeFile } from "./files.ts";
import { listVaults } from "./vaults.ts";

describe("request", () => {
  it("returns the JSON body", async () => {
    mockFetch({ "/api/vaults": () => Response.json({ vaults: [{ id: "a", name: "a" }] }) });
    expect(await listVaults()).toEqual([{ id: "a", name: "a" }]);
  });

  it("turns a server error into an ApiError with its code", async () => {
    mockFetch({
      "/api/vaults": () =>
        Response.json(
          { code: "forbidden", message: "You do not have permission to do this." },
          { status: 403 },
        ),
    });
    const error = await request("/api/vaults").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "forbidden", status: 403 });
  });

  it("falls back to unknown when the error body is not ours (a proxy page)", async () => {
    mockFetch({ "/x": () => new Response("<html>Bad gateway</html>", { status: 502 }) });
    expect(await request("/x").catch((e: unknown) => e)).toMatchObject({
      code: "unknown",
      status: 502,
    });
  });

  it("reports an unreachable server as network", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    expect(await request("/x").catch((e: unknown) => e)).toMatchObject({
      code: "network",
      status: 0,
    });
  });

  it("treats 204 as no content", async () => {
    mockFetch({ "/x": () => new Response(null, { status: 204 }) });
    expect(await request("/x", { method: "DELETE" })).toBeUndefined();
  });
});

describe("describeError", () => {
  it("translates by code, in the interface language", async () => {
    const en = await createI18n("en");
    const tw = await createI18n("zh-TW");
    const error = new ApiError("vault_not_found", 404, "The vault does not exist.");
    expect(describeError(en.t, error)).toBe("The vault does not exist.");
    expect(describeError(tw.t, error)).toBe("這個筆記庫不存在。");
    expect(describeError(tw.t, new ApiError("network", 0, ""))).toBe("無法連線到伺服器。");
    expect(describeError(en.t, new Error("boom"))).toBe("Something went wrong.");
  });
});

describe("files client", () => {
  it("encodes each path segment but keeps the slashes", () => {
    expect(encodePath("Projects/My notes/a#b.md")).toBe("Projects/My%20notes/a%23b.md");
  });

  it("reads and writes with the vault and path in the URL", async () => {
    const calls = mockFetch({
      "/api/vaults/my%20vault/files/A/B%20C.md": () =>
        Response.json({ path: "A/B C.md", content: "hi", mtime: 1, version: "v1" }),
    });
    expect((await readFile("my vault", "A/B C.md")).content).toBe("hi");
    await writeFile("my vault", "A/B C.md", "x", "v1");
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ content: "x", baseVersion: "v1" });
  });
});
