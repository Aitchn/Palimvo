import { describe, expect, it, vi } from "vitest";
import { PluginBridge, visibleEntries, type HostActions } from "./bridge.ts";
import { PROTOCOL_VERSION, RpcError } from "./protocol.ts";
import { PluginSession, bindingFor, type PluginActor } from "./session.ts";
import { TREE, fakeBackend, makePlugin } from "./testing.ts";

const everything: PluginActor = { read: true, write: true, propose: true };

function setup(
  permissions: { read?: string[]; write?: string[] },
  actor: PluginActor = everything,
  timeoutMs?: number,
) {
  const plugin = makePlugin({
    id: "demo",
    permissions: { read: permissions.read ?? [], write: permissions.write ?? [], network: false },
    contributes: { extensionPoints: [{ id: "badges" }] },
  });
  const session = new PluginSession(bindingFor("v", plugin.manifest, plugin.hash, actor));
  const backend = fakeBackend();
  const actions: HostActions = {
    openFile: vi.fn(),
    showNotice: vi.fn(),
    invokeExtension: vi.fn(async () => ["answer"]),
  };
  const bridge = new PluginBridge(session, backend, actions, timeoutMs);
  let n = 0;
  const call = (method: string, params: Record<string, unknown> = {}) =>
    bridge.request({
      type: "rpc",
      schemaVersion: PROTOCOL_VERSION,
      requestId: `r${++n}`,
      method,
      params,
    });
  return { bridge, session, backend, actions, call };
}

const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof RpcError ? error.code : `other:${String(error)}`),
  );

describe("reading", () => {
  it("reads inside the declared folders", async () => {
    const { call, backend } = setup({ read: ["decisions"] });
    await expect(call("vault.read", { path: "decisions/0001-a.md" })).resolves.toBe(
      "text of decisions/0001-a.md",
    );
    expect(backend.calls).toEqual(["read decisions/0001-a.md"]);
  });

  it("refuses everything outside them without calling the backend", async () => {
    const { call, backend } = setup({ read: ["decisions"] });
    expect(await code(call("vault.read", { path: "private/diary.md" }))).toBe("permission_denied");
    expect(await code(call("vault.readBinary", { path: "Welcome.md" }))).toBe("permission_denied");
    expect(await code(call("vault.queryBase", { path: "Welcome.base" }))).toBe("permission_denied");
    expect(backend.calls).toEqual([]);
  });

  it("refuses a plugin with no read folders at all", async () => {
    const { call } = setup({});
    expect(await code(call("vault.read", { path: "a.md" }))).toBe("permission_denied");
    expect(await code(call("vault.list"))).toBe("permission_denied");
    expect(await code(call("vault.search", { query: "x" }))).toBe("permission_denied");
  });

  it("refuses when the person cannot read, whatever the manifest says", async () => {
    const { call } = setup({ read: ["**"] }, { ...everything, read: false });
    expect(await code(call("vault.read", { path: "Welcome.md" }))).toBe("permission_denied");
  });

  it.each([
    "../private/diary.md",
    "decisions/../private/diary.md",
    "/etc/passwd",
    "C:\\secret.md",
    ".palimvo/config.json",
    ".git/config",
    "decisions/.palimvo/x",
  ])("treats %s as an invalid path", async (path) => {
    const { call, backend } = setup({ read: ["**"] });
    expect(await code(call("vault.read", { path }))).toBe("invalid_argument");
    expect(backend.calls).toEqual([]);
  });

  it("matches the folder after normalizing, so tricks do not escape it", async () => {
    const { call } = setup({ read: ["decisions"] });
    expect(await code(call("vault.read", { path: "decisions\\0001-a.md" }))).toBe("ok");
    expect(await code(call("vault.read", { path: "./private//diary.md" }))).toBe(
      "permission_denied",
    );
    // Case-sensitive on purpose: a differently spelled folder is not the declared one.
    expect(await code(call("vault.read", { path: "Decisions/0001-a.md" }))).toBe(
      "permission_denied",
    );
  });

  it("limits the bytes it hands over", async () => {
    const { call } = setup({ read: ["**"] });
    await expect(call("vault.readBinary", { path: "a.bin" })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});

describe("listing and searching", () => {
  it("shows only readable files and the folders on the way to them", async () => {
    const { call } = setup({ read: ["decisions/**"] });
    const entries = (await call("vault.list", { recursive: true })) as Array<{ path: string }>;
    expect(entries.map((e) => e.path)).toEqual([
      "decisions",
      "decisions/0001-a.md",
      "decisions/old",
      "decisions/old/0000.md",
    ]);
  });

  it("lists one level at a time inside a folder", async () => {
    const { call } = setup({ read: ["**"] });
    const entries = (await call("vault.list", { dir: "decisions" })) as Array<{ path: string }>;
    expect(entries.map((e) => e.path)).toEqual(["decisions/0001-a.md", "decisions/old"]);
  });

  it("returns nothing for a folder that does not exist or is not readable", async () => {
    const { call } = setup({ read: ["decisions"] });
    expect(await call("vault.list", { dir: "nope" })).toEqual([]);
    expect(await call("vault.list", { dir: "private" })).toEqual([]);
  });

  it("drops search hits outside the declared folders", async () => {
    const { call } = setup({ read: ["decisions", "Welcome.md"] });
    const hits = (await call("vault.search", { query: "x" })) as Array<{ path: string }>;
    expect(hits.map((h) => h.path)).toEqual(["decisions/0001-a.md", "Welcome.md"]);
  });

  it("honours the limit after filtering", async () => {
    const { call } = setup({ read: ["**"] });
    expect(await call("vault.search", { query: "x", limit: 1 })).toHaveLength(1);
  });

  it("hides rows of a database that come from other folders", async () => {
    const { call } = setup({ read: ["decisions", "tasks.base"] });
    const result = (await call("vault.queryBase", { path: "tasks.base" })) as {
      rows: Array<{ path: string }>;
    };
    expect(result.rows.map((r) => r.path)).toEqual(["decisions/0001-a.md"]);
  });
});

describe("writing", () => {
  it("writes inside the declared folders and says which plugin did", async () => {
    const { call, backend } = setup({ write: ["decisions"] });
    await expect(
      call("vault.write", { path: "decisions/0002.md", content: "hi", reason: "because" }),
    ).resolves.toEqual({ revision: "r1" });
    expect(backend.calls).toEqual(["write decisions/0002.md hi because"]);
  });

  it("refuses to write outside them", async () => {
    const { call, backend } = setup({ write: ["decisions"], read: ["**"] });
    expect(await code(call("vault.write", { path: "Welcome.md", content: "x" }))).toBe(
      "permission_denied",
    );
    expect(backend.calls).toEqual([]);
  });

  it("refuses a plugin that only declared read", async () => {
    const { call } = setup({ read: ["**"] });
    expect(await code(call("vault.write", { path: "a.md", content: "x" }))).toBe(
      "permission_denied",
    );
  });

  it("refuses when the person may not write", async () => {
    const { call } = setup({ write: ["**"] }, { ...everything, write: false });
    expect(await code(call("vault.write", { path: "a.md", content: "x" }))).toBe(
      "permission_denied",
    );
  });

  it("lets a person who may only propose have the plugin propose", async () => {
    const { call, backend } = setup(
      { write: ["decisions"] },
      { read: true, write: false, propose: true },
    );
    expect(await code(call("vault.propose", { path: "decisions/x.md", content: "x" }))).toBe("ok");
    expect(backend.calls).toEqual(["propose decisions/x.md"]);
    expect(await code(call("vault.propose", { path: "Welcome.md", content: "x" }))).toBe(
      "permission_denied",
    );
  });

  it("cannot be talked into touching the plugin's own files", async () => {
    const { call } = setup({ read: ["**"], write: ["**"] });
    expect(
      await code(call("vault.write", { path: ".palimvo/plugins/demo/main.js", content: "x" })),
    ).toBe("invalid_argument");
  });
});

describe("ui calls", () => {
  it("opens a file only inside readable folders", async () => {
    const { call, actions } = setup({ read: ["decisions"] });
    await call("ui.openFile", { path: "decisions/0001-a.md" });
    expect(actions.openFile).toHaveBeenCalledWith("decisions/0001-a.md");
    expect(await code(call("ui.openFile", { path: "private/diary.md" }))).toBe("permission_denied");
  });

  it("shows notices with a safe kind and a bounded length", async () => {
    const { call, actions } = setup({});
    await call("ui.showNotice", { message: "x".repeat(1000), kind: "weird" });
    expect(actions.showNotice).toHaveBeenCalledWith("x".repeat(300), "info");
  });

  it("has no source to update unless the frame is a code block", async () => {
    const { call } = setup({});
    expect(await code(call("ui.updateSource", { source: "a" }))).toBe("unavailable");
  });

  it("answers extension calls only for the points the plugin declared", async () => {
    const { call, actions } = setup({});
    await expect(call("extensions.invoke", { point: "badges", input: { a: 1 } })).resolves.toEqual([
      "answer",
    ]);
    expect(actions.invokeExtension).toHaveBeenCalledWith("badges", { a: 1 }, expect.anything());
    expect(await code(call("extensions.invoke", { point: "other" }))).toBe("permission_denied");
  });
});

describe("lifecycle", () => {
  it("refuses a request id it has seen", async () => {
    const { bridge } = setup({ read: ["**"] });
    const request = {
      type: "rpc",
      schemaVersion: PROTOCOL_VERSION,
      requestId: "same",
      method: "vault.read",
      params: { path: "a.md" },
    };
    await bridge.request(request);
    expect(await code(bridge.request(request))).toBe("invalid_argument");
  });

  it("refuses malformed messages", async () => {
    const { bridge } = setup({ read: ["**"] });
    expect(await code(bridge.request({ nonsense: true }))).toBe("invalid_argument");
  });

  it("times out a call that never answers", async () => {
    vi.useFakeTimers();
    try {
      const { call, backend } = setup({ read: ["**"] }, everything, 1000);
      backend.read = () => new Promise(() => {});
      const pending = code(call("vault.read", { path: "a.md" }));
      await vi.advanceTimersByTimeAsync(1100);
      expect(await pending).toBe("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the result of a call cancelled before it finished", async () => {
    const { bridge, backend } = setup({ read: ["**"] });
    let finish: (value: string) => void = () => {};
    backend.read = () => new Promise((resolve) => (finish = resolve));
    const pending = code(
      bridge.request({
        type: "rpc",
        schemaVersion: PROTOCOL_VERSION,
        requestId: "c1",
        method: "vault.read",
        params: { path: "a.md" },
      }),
    );
    await Promise.resolve();
    bridge.cancel("c1");
    finish("late");
    expect(await pending).toBe("unavailable");
  });

  it("stops everything in flight when the session is revoked, and refuses new calls", async () => {
    const { session, call, backend } = setup({ read: ["**"] });
    backend.read = () => new Promise(() => {});
    const pending = code(call("vault.read", { path: "a.md" }));
    await Promise.resolve();
    session.revoke("approval withdrawn");
    expect(await pending).toBe("unavailable");
    expect(await code(call("vault.list"))).toBe("invalid_argument");
  });

  it("does not deliver a result that arrives after revocation", async () => {
    const { session, call, backend } = setup({ read: ["**"] });
    let finish: (value: string) => void = () => {};
    backend.read = () => new Promise((resolve) => (finish = resolve));
    const pending = code(call("vault.read", { path: "a.md" }));
    await Promise.resolve();
    session.revoke();
    finish("secret");
    expect(await pending).not.toBe("ok");
  });
});

describe("visibleEntries", () => {
  it("does not reveal folders that lead nowhere readable", () => {
    const entries = visibleEntries(TREE, "", true, (path) => path === "Welcome.md");
    expect(entries.map((e) => e.path)).toEqual(["Welcome.md"]);
  });
});
