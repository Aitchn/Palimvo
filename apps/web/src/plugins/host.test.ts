import { describe, expect, it, vi } from "vitest";
import { PluginHost, scopeFileEvent } from "./host.ts";
import { bindingFor } from "./session.ts";
import { fakeBackend, makePlugin } from "./testing.ts";

const actor = { read: true, write: true, propose: true };

function newHost() {
  return new PluginHost({
    vault: "v",
    actor,
    locale: () => "en",
    theme: () => "dark",
    openFile: () => {},
    showNotice: () => {},
    backend: () => fakeBackend(),
  });
}

describe("setPlugins", () => {
  it("keeps the session of a plugin whose hash did not change", () => {
    const host = newHost();
    host.setPlugins([makePlugin({ id: "a" })]);
    const first = host.get("a")!;
    const revision = host.revision;
    host.setPlugins([makePlugin({ id: "a" })]);
    expect(host.get("a")).toBe(first);
    expect(first.session.active).toBe(true);
    expect(host.revision).toBe(revision);
  });

  it("revokes a plugin whose hash changed and starts a new session", () => {
    const host = newHost();
    host.setPlugins([makePlugin({ id: "a" }, { hash: "1".repeat(64) })]);
    const old = host.get("a")!;
    host.setPlugins([makePlugin({ id: "a" }, { hash: "2".repeat(64) })]);
    expect(old.session.active).toBe(false);
    expect(host.get("a")!.session.active).toBe(true);
    expect(host.get("a")).not.toBe(old);
  });

  it("revokes a plugin that is no longer in the set", () => {
    const host = newHost();
    host.setPlugins([makePlugin({ id: "a" }), makePlugin({ id: "b" })]);
    const a = host.get("a")!;
    host.setPlugins([makePlugin({ id: "b" })]);
    expect(a.session.active).toBe(false);
    expect(host.get("a")).toBeUndefined();
    expect(host.get("b")!.session.active).toBe(true);
  });

  it("tells subscribers when something changed, and only then", () => {
    const host = newHost();
    const listener = vi.fn();
    host.subscribe(listener);
    host.setPlugins([makePlugin({ id: "a" })]);
    host.setPlugins([makePlugin({ id: "a" })]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("revokes all sessions when the person's rights change", () => {
    const host = newHost();
    host.setPlugins([makePlugin({ id: "a", permissions: { write: ["**"] } })]);
    const old = host.get("a")!;
    expect(old.session.binding.actor.write).toBe(true);
    host.setActor({ read: true, write: false, propose: false });
    expect(old.session.active).toBe(false);
    expect(host.get("a")!.session.binding.actor.write).toBe(false);
    expect(host.get("a")!.session.active).toBe(true);
  });

  it("ignores a rights update that changes nothing", () => {
    const host = newHost();
    host.setPlugins([makePlugin({ id: "a" })]);
    const old = host.get("a")!;
    host.setActor({ ...actor });
    expect(host.get("a")).toBe(old);
  });

  it("revokes everything and ignores later updates after dispose", () => {
    const host = newHost();
    host.setPlugins([makePlugin({ id: "a" })]);
    const old = host.get("a")!;
    host.dispose();
    expect(old.session.active).toBe(false);
    host.setPlugins([makePlugin({ id: "b" })]);
    expect(host.get("b")).toBeUndefined();
    expect(() =>
      host.mount(document.createElement("div"), { pluginId: "a", mode: "view", target: "x" }),
    ).toThrow();
  });
});

describe("contributors", () => {
  const provider = makePlugin({
    id: "kanban",
    version: "1.2.0",
    contributes: { extensionPoints: [{ id: "badges" }] },
  });
  const contributor = (id: string, range = "^1.0.0", point = "badges") =>
    makePlugin({
      id,
      dependencies: { kanban: range },
      contributes: { extensions: [{ plugin: "kanban", point }] },
    });

  it("finds plugins that contribute to the point and accept the provider's version", () => {
    const host = newHost();
    host.setPlugins([provider, contributor("zz-due"), contributor("aa-owner")]);
    expect(host.contributors("kanban", "badges").map((c) => c.plugin.manifest.id)).toEqual([
      "aa-owner",
      "zz-due",
    ]);
  });

  it("skips the wrong point and the wrong version", () => {
    const host = newHost();
    host.setPlugins([
      provider,
      contributor("old", "^0.5.0"),
      contributor("other", "^1.0.0", "colors"),
    ]);
    expect(host.contributors("kanban", "badges")).toEqual([]);
  });

  it("finds nobody when the provider does not run", () => {
    const host = newHost();
    host.setPlugins([contributor("lonely")]);
    expect(host.contributors("kanban", "badges")).toEqual([]);
  });

  it("answers an empty list when there is no contributor", async () => {
    const host = newHost();
    host.setPlugins([provider]);
    await expect(host.invokeExtension("kanban", "badges", { a: 1 })).resolves.toEqual([]);
  });

  it("refuses input that is not plain data", async () => {
    const host = newHost();
    host.setPlugins([provider]);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(host.invokeExtension("kanban", "badges", cycle)).rejects.toThrow(/plain data/);
  });
});

describe("scopeFileEvent", () => {
  const plugin = makePlugin({ id: "a", permissions: { read: ["decisions"] } });
  const binding = bindingFor("v", plugin.manifest, plugin.hash, actor);
  const event = (e: object) => ({ author: "Ada", ...e }) as Parameters<typeof scopeFileEvent>[1];

  it("passes events about readable files", () => {
    const e = event({ path: "decisions/a.md", kind: "modified" });
    expect(scopeFileEvent(binding, e)).toBe(e);
  });

  it("hides events about other files", () => {
    expect(scopeFileEvent(binding, event({ path: "private/a.md", kind: "modified" }))).toBeNull();
  });

  it("turns a move across the border into a create or a delete, never revealing the other end", () => {
    expect(
      scopeFileEvent(
        binding,
        event({ path: "decisions/a.md", from: "private/a.md", kind: "moved" }),
      ),
    ).toEqual({ path: "decisions/a.md", kind: "created", author: "Ada" });
    expect(
      scopeFileEvent(
        binding,
        event({ path: "private/a.md", from: "decisions/a.md", kind: "moved" }),
      ),
    ).toEqual({ path: "decisions/a.md", kind: "deleted", author: "Ada" });
    expect(
      scopeFileEvent(binding, event({ path: "x/b.md", from: "private/a.md", kind: "moved" })),
    ).toBeNull();
  });

  it("keeps a move inside the border as it is", () => {
    const e = event({ path: "decisions/b.md", from: "decisions/a.md", kind: "moved" });
    expect(scopeFileEvent(binding, e)).toBe(e);
  });
});
