import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@palimvo/plugin-sdk";
import { resolveDependencies } from "./deps.ts";

const plugin = (id: string, version: string, deps: Record<string, string> = {}, wanted = true) => ({
  manifest: { id, version, dependencies: deps } as unknown as PluginManifest,
  wanted,
});
const codes = (r: ReturnType<typeof resolveDependencies>, id: string) =>
  (r.get(id) ?? []).map((p) => p.code);

describe("resolveDependencies", () => {
  it("lets plugins without dependencies run", () => {
    expect(codes(resolveDependencies([plugin("a", "1.0.0")]), "a")).toEqual([]);
  });

  it("blocks a plugin whose dependency is missing", () => {
    expect(codes(resolveDependencies([plugin("a", "1.0.0", { b: "^1.0.0" })]), "a")).toEqual([
      "dependency_missing",
    ]);
  });

  it("checks the version range", () => {
    const r = resolveDependencies([plugin("a", "1.0.0", { b: "^2.0.0" }), plugin("b", "1.5.0")]);
    expect(codes(r, "a")).toEqual(["dependency_version"]);
    expect(codes(r, "b")).toEqual([]);
  });

  it("blocks when the dependency is installed but not wanted", () => {
    const r = resolveDependencies([
      plugin("a", "1.0.0", { b: "*" }),
      plugin("b", "1.0.0", {}, false),
    ]);
    expect(codes(r, "a")).toEqual(["dependency_not_running"]);
    expect(r.get("b")).toEqual([]);
  });

  it("follows chains", () => {
    const r = resolveDependencies([
      plugin("a", "1.0.0", { b: "*" }),
      plugin("b", "1.0.0", { c: "*" }),
      plugin("c", "1.0.0", {}, false),
    ]);
    expect(codes(r, "b")).toEqual(["dependency_not_running"]);
    expect(codes(r, "a")).toEqual(["dependency_not_running"]);
  });

  it("runs nothing in a cycle, but not what is outside it", () => {
    const r = resolveDependencies([
      plugin("a", "1.0.0", { b: "*" }),
      plugin("b", "1.0.0", { a: "*" }),
      plugin("c", "1.0.0", { a: "*" }),
      plugin("d", "1.0.0"),
      plugin("self", "1.0.0", { self: "*" }),
    ]);
    expect(codes(r, "a")).toEqual(["dependency_cycle"]);
    expect(codes(r, "b")).toEqual(["dependency_cycle"]);
    expect(codes(r, "self")).toEqual(["dependency_cycle"]);
    expect(codes(r, "c")).toEqual(["dependency_not_running"]);
    expect(codes(r, "d")).toEqual([]);
  });
});
