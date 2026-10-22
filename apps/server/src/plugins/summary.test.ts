import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@palimvo/plugin-sdk";
import type { RequestAccess } from "../auth/access.ts";
import { pluginMayAccess, summarizePermissions } from "./summary.ts";
import { inspectPackage } from "./package.ts";
import { samplePackage } from "./testing.ts";

const manifestOf = async (extra: Record<string, unknown>): Promise<PluginManifest> =>
  (await inspectPackage(samplePackage("p", "1.0.0", extra))).manifest;

describe("summarizePermissions", () => {
  it("flags whole-vault and any-host requests", async () => {
    const broad = summarizePermissions(
      await manifestOf({ permissions: { read: ["**"], write: ["**"], network: ["*"] } }),
    );
    expect(broad).toMatchObject({
      readsWholeVault: true,
      writesWholeVault: true,
      anyNetwork: true,
    });
    expect(broad.warnings.length).toBeGreaterThan(0);
    const narrow = summarizePermissions(
      await manifestOf({ permissions: { read: ["notes"], write: ["notes/out"], network: false } }),
    );
    expect(narrow).toMatchObject({
      readsWholeVault: false,
      writesWholeVault: false,
      anyNetwork: false,
    });
    expect(narrow.contributes).toEqual({ views: 1 });
  });

  it("lists tools with their qualified names", async () => {
    const m = await manifestOf({
      server: "main.js",
      contributes: {
        tools: [
          { name: "count", description: "Count", inputSchema: { type: "object" }, readOnly: true },
          { name: "move", description: "Move", inputSchema: { type: "object" } },
        ],
      },
    });
    expect(summarizePermissions(m).tools).toEqual([
      { name: "p.count", readOnly: true },
      { name: "p.move", readOnly: false },
    ]);
  });
});

describe("pluginMayAccess", () => {
  const person = (allowed: string[]): RequestAccess =>
    ({ can: (name: string) => allowed.includes(name) }) as unknown as RequestAccess;

  it("needs both the manifest's folder and the person's permission", async () => {
    const m = await manifestOf({
      permissions: { read: ["notes"], write: ["notes/out"], network: false },
    });
    const full = person(["note.read", "note.write"]);
    expect(pluginMayAccess(m, "read", "v", "notes/a.md", full)).toBe(true);
    expect(pluginMayAccess(m, "read", "v", "other/a.md", full)).toBe(false);
    expect(pluginMayAccess(m, "write", "v", "notes/a.md", full)).toBe(false);
    expect(pluginMayAccess(m, "write", "v", "notes/out/a.md", full)).toBe(true);
    // A reader gets nothing more because the plugin asks for more.
    expect(pluginMayAccess(m, "write", "v", "notes/out/a.md", person(["note.read"]))).toBe(false);
  });
});
