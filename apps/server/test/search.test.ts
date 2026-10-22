import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
  expect((await server.fetch("/api/vaults", post({ id: "demo" }))).status).toBe(201);
});
afterEach(() => server.dispose());

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const put = (path: string, content: string) =>
  server.fetch(`/api/vaults/demo/files/${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
/** What the search routes answer with, loosely typed: the tests compare it with literals. */
interface Body {
  code?: string;
  total?: number;
  hits: { path: string }[];
  edges: unknown[];
  unresolved: unknown[];
  [key: string]: unknown;
}
const get = async (url: string) => {
  const res = await server.fetch(url);
  return { status: res.status, body: (await res.json()) as Body };
};

describe("search API", () => {
  beforeEach(async () => {
    await put("a.md", "alpha 決策 [[b]]");
    await put("b.md", "beta [[a]] and [[ghost]]");
  });

  it("searches with paging", async () => {
    const { status, body } = await get(`/api/vaults/demo/search?q=${encodeURIComponent("決策")}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ query: "決策", total: 1, offset: 0, limit: 50 });
    expect(body.hits).toEqual([
      { path: "a.md", titleMatch: false, matches: [{ line: 1, text: "alpha 決策 [[b]]" }] },
    ]);
    const page = await get("/api/vaults/demo/search?q=beta&limit=1&offset=5");
    expect(page.body).toMatchObject({ total: 1, offset: 5, limit: 1, hits: [] });
  });

  it("restricts a search to a folder", async () => {
    await put("sub/c.md", "alpha too");
    const all = await get("/api/vaults/demo/search?q=alpha");
    expect(all.body.total).toBe(2);
    const sub = await get("/api/vaults/demo/search?q=alpha&path=sub");
    expect(sub.body.hits.map((h) => h.path)).toEqual(["sub/c.md"]);
  });

  it("rejects bad parameters", async () => {
    expect((await get("/api/vaults/demo/search")).body.code).toBe("invalid_request");
    expect((await get("/api/vaults/demo/search?q=a&limit=0")).status).toBe(400);
    expect((await get("/api/vaults/demo/search?q=a&limit=1000")).status).toBe(400);
    expect((await get("/api/vaults/demo/search?q=a&offset=-1")).status).toBe(400);
    expect((await get("/api/vaults/demo/search?q=a&path=..")).body.code).toBe("invalid_path");
    expect((await get("/api/vaults/nope/search?q=a")).body.code).toBe("vault_not_found");
  });

  it("serves backlinks, outgoing links and the graph", async () => {
    expect((await get("/api/vaults/demo/backlinks?path=a.md")).body).toEqual({
      backlinks: [{ path: "b.md", lines: [{ line: 1, text: "beta [[a]] and [[ghost]]" }] }],
    });
    expect((await get("/api/vaults/demo/links?path=b.md")).body).toEqual({
      links: [
        { target: "a", path: "a.md", embed: false },
        { target: "ghost", path: null, embed: false },
      ],
    });
    const graph = (await get("/api/vaults/demo/graph")).body;
    expect(graph.edges).toEqual([
      { from: "a.md", to: "b.md", embed: false },
      { from: "b.md", to: "a.md", embed: false },
    ]);
    expect(graph.unresolved).toContainEqual({ from: "b.md", target: "ghost" });
    expect((await get("/api/vaults/demo/backlinks")).body.code).toBe("invalid_request");
    expect((await get("/api/vaults/demo/links?path=missing.md")).status).toBe(404);
  });
});

describe("graph API options", () => {
  beforeEach(async () => {
    await put("a.md", "---\ntags: [plan]\n---\nsee [[b]] #idea");
    await put("b.md", "to [[c]]");
    await put("c.md", "to [[d]]");
    await put("d.md", "end");
    await put("lonely.md", "nobody links here");
  });

  const paths = (body: Body) => (body.nodes as { path: string }[]).map((n) => n.path).sort();

  it("adds tags to the notes only when asked", async () => {
    const plain = (await get("/api/vaults/demo/graph")).body;
    expect((plain.nodes as { tags?: string[] }[]).some((n) => n.tags !== undefined)).toBe(false);
    const tagged = (await get("/api/vaults/demo/graph?tags=1")).body;
    const nodes = tagged.nodes as { path: string; tags?: string[] }[];
    expect(nodes.find((n) => n.path === "a.md")?.tags).toEqual(["plan", "idea"]);
    expect(nodes.find((n) => n.path === "b.md")?.tags).toBeUndefined();
  });

  it("returns only the files within some links of one file, in both directions", async () => {
    const one = (await get("/api/vaults/demo/graph?around=b.md")).body;
    expect(paths(one)).toEqual(["a.md", "b.md", "c.md"]);
    expect(one.edges).toEqual([
      { from: "a.md", to: "b.md", embed: false },
      { from: "b.md", to: "c.md", embed: false },
    ]);
    const two = (await get("/api/vaults/demo/graph?around=b.md&depth=2")).body;
    expect(paths(two)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    const alone = (await get("/api/vaults/demo/graph?around=lonely.md&depth=3")).body;
    expect(paths(alone)).toEqual(["lonely.md"]);
    expect(paths((await get("/api/vaults/demo/graph?around=missing.md")).body)).toEqual([]);
  });

  it("rejects bad graph parameters", async () => {
    expect((await get("/api/vaults/demo/graph?depth=0&around=a.md")).status).toBe(400);
    expect((await get("/api/vaults/demo/graph?depth=99&around=a.md")).status).toBe(400);
    expect((await get("/api/vaults/demo/graph?around=..")).body.code).toBe("invalid_path");
    expect((await get("/api/vaults/demo/graph?tags=maybe")).status).toBe(400);
  });
});
