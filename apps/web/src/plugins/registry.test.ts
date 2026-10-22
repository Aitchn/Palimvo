import { describe, expect, it } from "vitest";
import { PluginHost } from "./host.ts";
import { ContributionRegistry } from "./registry.ts";
import { fakeBackend, makePlugin } from "./testing.ts";

function hostWith(...plugins: ReturnType<typeof makePlugin>[]) {
  const host = new PluginHost({
    vault: "v",
    actor: { read: true, write: true, propose: true },
    locale: () => "en",
    theme: () => "dark",
    openFile: () => {},
    showNotice: () => {},
    backend: () => fakeBackend(),
  });
  host.setPlugins(plugins);
  return host;
}

describe("ContributionRegistry", () => {
  it("lists views, widgets and viewers of every running plugin, ordered by plugin id", () => {
    const host = hostWith(
      makePlugin({
        id: "b-board",
        contributes: {
          views: [{ id: "board", name: "Board" }],
          homeWidgets: [{ id: "due", name: "Due", size: "large" }],
        },
      }),
      makePlugin({
        id: "a-json",
        permissions: { read: ["**"] },
        contributes: { viewers: [{ id: "tree", name: "Tree", extensions: ["json", "geojson"] }] },
      }),
    );
    const registry = new ContributionRegistry(host.list());
    expect(registry.views.map((v) => `${v.pluginId}/${v.id}`)).toEqual(["b-board/board"]);
    expect(registry.homeWidget("b-board", "due")?.size).toBe("large");
    expect(registry.homeWidget("b-board", "nope")).toBeUndefined();
    expect(registry.viewersFor("data/file.JSON").map((v) => v.id)).toEqual(["tree"]);
    expect(registry.viewersFor("data/file.md")).toEqual([]);
    expect(registry.viewersFor("Makefile")).toEqual([]);
    expect([...registry.viewerExtensions].sort()).toEqual(["geojson", "json"]);
  });

  it("gives a claimed language to nobody when two plugins both claim it", () => {
    const host = hostWith(
      makePlugin({
        id: "one",
        contributes: { codeBlocks: [{ language: "chart" }, { language: "solo" }] },
      }),
      makePlugin({ id: "two", contributes: { codeBlocks: [{ language: "chart" }] } }),
    );
    const registry = new ContributionRegistry(host.list());
    expect(registry.codeBlocks.get("solo")).toBe("one");
    expect(registry.codeBlocks.has("chart")).toBe(false);
    expect(registry.conflicts).toEqual(['code block "chart": one, two']);
  });

  it("skips plugins whose session was revoked", () => {
    const host = hostWith(
      makePlugin({ id: "gone", contributes: { views: [{ id: "x", name: "X" }] } }),
    );
    const entry = host.get("gone")!;
    const list = host.list();
    entry.session.revoke();
    expect(new ContributionRegistry(list).views).toEqual([]);
  });

  it("lists slot entries by slot, apps and themes of running plugins", () => {
    const host = hostWith(
      makePlugin({
        id: "tools",
        contributes: {
          slots: [
            { slot: "toolbar", id: "a", title: "A" },
            { slot: "status-bar", id: "b", title: "B", icon: "info" },
            { slot: "toolbar", id: "c", title: "C" },
          ],
          app: { name: "Tools app" },
        },
      }),
      makePlugin({ id: "paint", contributes: { theme: { name: "Paint", css: "theme.css" } } }, {}),
      makePlugin({ id: "no-css", contributes: { theme: { name: "No css", css: "theme.css" } } }),
    );
    const withCss = host
      .list()
      .map((entry) =>
        entry.plugin.manifest.id === "paint"
          ? { ...entry, plugin: { ...entry.plugin, themeCss: ":root{--a:1}" } }
          : entry,
      );
    const registry = new ContributionRegistry(withCss);
    expect(registry.slotEntries("toolbar").map((s) => s.id)).toEqual(["a", "c"]);
    expect(registry.slotEntries("status-bar")[0]?.icon).toBe("info");
    expect(registry.slotEntries("settings")).toEqual([]);
    expect(registry.apps.map((a) => a.pluginId)).toEqual(["tools"]);
    // A theme without a stylesheet in the bundle is not offered.
    expect(registry.themes.map((t) => t.pluginId)).toEqual(["paint"]);
  });
});
