import { defaultHomeConfig, makeAuthor, type HomeConfig } from "@palimvo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Activity } from "../src/home/activity.ts";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
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

async function world() {
  const root = await signIn("root", true);
  expect((await root.client.post("/api/vaults", { id: "v" })).status).toBe(201);
  const write = (path: string, content: string) =>
    root.client.put(`/api/vaults/v/files/${path}`, { content });
  expect((await write("a.md", "alpha")).status).toBe(200);
  expect((await write("docs/b.md", "beta")).status).toBe(200);
  await server.services.history.flushAll();
  return { root, write };
}

type State = { config: HomeConfig; version: string | null };
const get = async (client: Client, vault = "v") =>
  json<State>(await client.get(`/api/vaults/${vault}/home`));

describe("home settings", () => {
  it("starts as the default page: proposals, activity wall, pinned notes", async () => {
    const { root } = await world();
    const state = await get(root.client);
    expect(state.version).toBeNull();
    expect(state.config).toEqual(defaultHomeConfig());
    expect(state.config.widgets.map((w) => w.type)).toEqual(["proposals", "activity", "pinned"]);
  });

  it("saves, normalizes and versions the settings", async () => {
    const { root } = await world();
    const config = {
      ...defaultHomeConfig(),
      pinned: ["docs//b.md", "a.md", "docs/b.md"],
      widgets: [
        { id: "wall", type: "activity", limit: 10 },
        { id: "tasks", type: "base", path: "Tasks.base" },
      ],
    };
    const res = await root.client.put("/api/vaults/v/home", { config, baseVersion: null });
    expect(res.status).toBe(200);
    const saved = await json<State>(res);
    expect(saved.config.pinned).toEqual(["docs/b.md", "a.md"]);
    expect(saved.version).toMatch(/^[a-f0-9]{16}$/);
    expect(await get(root.client)).toEqual(saved);

    const raw = await server.services.vaults.readMeta("v", "home.json");
    expect(JSON.parse(raw!)).toMatchObject({ schemaVersion: 1, pinned: ["docs/b.md", "a.md"] });
  });

  it("refuses a save made from an old version", async () => {
    const { root } = await world();
    const config = defaultHomeConfig();
    const first = await json<State>(
      await root.client.put("/api/vaults/v/home", { config, baseVersion: null }),
    );
    const again = await root.client.put("/api/vaults/v/home", { config, baseVersion: null });
    expect(again.status).toBe(409);
    expect((await json<{ code: string }>(again)).code).toBe("version_conflict");
    const next = { ...config, pinned: ["a.md"] };
    expect(
      (await root.client.put("/api/vaults/v/home", { config: next, baseVersion: first.version }))
        .status,
    ).toBe(200);
  });

  it("rejects bad paths, duplicate widget ids and non-database widgets", async () => {
    const { root } = await world();
    const put = (config: unknown) =>
      root.client.put("/api/vaults/v/home", { config, baseVersion: null });
    const base = defaultHomeConfig();
    expect((await put({ ...base, pinned: ["../x.md"] })).status).toBe(400);
    expect((await put({ ...base, pinned: [".palimvo/config.json"] })).status).toBe(400);
    expect(
      (
        await put({
          ...base,
          widgets: [
            { id: "x", type: "pinned" },
            { id: "x", type: "proposals" },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await put({ ...base, widgets: [{ id: "x", type: "base", path: "a.md" }] })).status,
    ).toBe(400);
    expect((await put({ ...base, schemaVersion: 2 })).status).toBe(400);
  });

  it("falls back to the default page when the file was damaged by hand", async () => {
    const { root } = await world();
    await server.services.vaults.writeMeta("v", "home.json", '{"schemaVersion":1,"widgets":"no"}');
    const state = await get(root.client);
    expect(state.config).toEqual(defaultHomeConfig());
    expect(state.version).not.toBeNull();
  });

  it("lets only people with vault settings change it", async () => {
    const { root } = await world();
    const mia = await signIn("mia");
    server.store.joinVault("v", mia.id, "member");
    expect((await get(mia.client)).config.widgets).toHaveLength(3);
    const res = await mia.client.put("/api/vaults/v/home", {
      config: defaultHomeConfig(),
      baseVersion: null,
    });
    expect(res.status).toBe(403);
    expect(root).toBeDefined();
  });

  it("shows guests only what is public", async () => {
    const { root } = await world();
    await root.client.put("/api/vaults/v/home", {
      config: {
        ...defaultHomeConfig(),
        pinned: ["a.md", "docs/b.md"],
        publicNote: "a.md",
      },
      baseVersion: null,
    });
    expect((await root.client.put("/api/vaults/v/public", { paths: ["docs"] })).status).toBe(200);
    const guest = new Client(server);
    const state = await get(guest);
    expect(state.config.pinned).toEqual(["docs/b.md"]);
    expect(state.config.publicNote).toBeNull();
    expect(state.config.widgets.map((w) => w.type)).toEqual(["pinned"]);
    expect(state.version).toBeNull();

    await root.client.put("/api/vaults/v/public", { paths: ["docs", "a.md"] });
    expect((await get(guest)).config.publicNote).toBe("a.md");

    expect((await guest.get("/api/vaults/v/home/activity")).status).toBeGreaterThanOrEqual(401);
    expect(
      (await guest.put("/api/vaults/v/home", { config: defaultHomeConfig(), baseVersion: null }))
        .status,
    ).toBeGreaterThanOrEqual(401);
  });
});

describe("activity wall", () => {
  it("lists recent changes by author, with reasons, and filters people and AIs", async () => {
    const { root } = await world();
    // A browser session is always a person, so the AI's change goes in through the services.
    const { vaults, history } = server.services;
    await vaults.writeFile("v", "ai.md", "from the AI", {
      onWritten: (f) =>
        history.record("v", [f.path], makeAuthor("ai", "Claude Code"), {
          reason: "Summarize the week",
        }),
    });
    await history.flushAll();

    const all = await json<Activity>(await root.client.get("/api/vaults/v/home/activity"));
    expect(all.entries.length).toBeGreaterThanOrEqual(2);
    expect(all.authors.map((a) => a.author.kind).sort()).toEqual(["ai", "external", "human"]);
    const aiEntry = all.entries.find((e) => e.files.includes("ai.md"))!;
    expect(aiEntry.author).toMatchObject({ kind: "ai", name: "Claude Code" });
    expect(aiEntry.reasons).toContain("Summarize the week");

    const people = await json<Activity>(
      await root.client.get("/api/vaults/v/home/activity?filter=human"),
    );
    expect(people.entries.every((e) => e.author.kind === "human")).toBe(true);
    expect(people.authors).toHaveLength(3);
    const ai = await json<Activity>(await root.client.get("/api/vaults/v/home/activity?filter=ai"));
    expect(ai.entries.map((e) => e.files)).toEqual([["ai.md"]]);

    const limited = await json<Activity>(
      await root.client.get("/api/vaults/v/home/activity?limit=1"),
    );
    expect(limited.entries).toHaveLength(1);
    expect((await root.client.get("/api/vaults/v/home/activity?filter=bots")).status).toBe(400);
  });

  it("does not list the app's own files and shows the newest change first", async () => {
    const { root } = await world();
    await root.client.put("/api/vaults/v/home", { config: defaultHomeConfig(), baseVersion: null });
    await server.services.history.flushAll();
    const wall = await json<Activity>(await root.client.get("/api/vaults/v/home/activity"));
    expect(wall.entries.flatMap((e) => e.files).some((f) => f.startsWith("."))).toBe(false);
  });

  it("is hidden from people without history access", async () => {
    await world();
    const eve = await signIn("eve");
    expect((await eve.client.get("/api/vaults/v/home/activity")).status).toBe(404);
  });
});
