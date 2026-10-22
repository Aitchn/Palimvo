import { describe, expect, it } from "vitest";
import { convertLegacyManifest } from "./legacy.ts";

describe("convertLegacyManifest", () => {
  it("converts a typical version 1 manifest", () => {
    const r = convertLegacyManifest({
      id: "kanban",
      name: "Kanban",
      version: "1.2",
      description: "Board",
      author: "Me",
      apiVersion: 1,
      minHostVersion: "1.0.0",
      permissions: ["read", "write"],
      scope: { paths: ["projects", "/notes/"] },
      views: [{ id: "board", name: "Board", locations: ["sidebar", "home"] }],
      codeBlocks: ["kanban"],
      requires: [{ id: "base-tools", version: "^1.0.0" }, { id: "other" }],
      extensionPoints: [{ id: "badge", name: "Badge" }],
      extends: [{ plugin: "base-tools", point: "x" }],
      fileTypes: [{ extension: "nbs", mime: "audio/x-nbs", maxBytes: 5000 }],
      fileViews: [{ id: "nbs", name: "NBS", extensions: ["nbs"] }],
      components: [{ type: "gauge-x", name: "Gauge" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.manifest;
    expect(m.version).toBe("1.2.0");
    expect(m.permissions).toEqual({
      read: ["projects", "notes"],
      write: ["projects", "notes"],
      network: false,
    });
    expect(m.dependencies).toEqual({ "base-tools": "^1.0.0", other: "*" });
    expect(m.contributes.views).toEqual([{ id: "board", name: "Board" }]);
    expect(m.contributes.homeWidgets).toEqual([{ id: "board", name: "Board" }]);
    expect(m.contributes.codeBlocks).toEqual([{ language: "kanban" }]);
    expect(m.contributes.viewers[0]?.extensions).toEqual(["nbs"]);
    expect(m.contributes.extensions).toEqual([{ plugin: "base-tools", point: "x" }]);
    expect(r.notes.join("\n")).toMatch(/Version "1.2"/);
    expect(r.notes.join("\n")).toMatch(/minHostVersion/);
  });

  it("maps no scope to the whole vault and network to an explicit wildcard", () => {
    const r = convertLegacyManifest({
      id: "a",
      name: "A",
      version: "1.0.0",
      permissions: ["read", "network"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.permissions).toEqual({ read: ["**"], write: [], network: ["*"] });
    expect(r.notes.join("\n")).toMatch(/network/);
  });

  it("drops scope paths with wildcard characters and says so", () => {
    const r = convertLegacyManifest({
      id: "a",
      name: "A",
      version: "1.0.0",
      permissions: ["read"],
      scope: { paths: ["a*b", "ok"] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.permissions.read).toEqual(["ok"]);
    expect(r.notes.join("\n")).toMatch(/dropped/);
  });

  it("reports problems that remain after conversion", () => {
    expect(convertLegacyManifest(null).ok).toBe(false);
    const r = convertLegacyManifest({ id: "Bad Id", name: "A", version: "1.0.0", permissions: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("id");
  });
});
