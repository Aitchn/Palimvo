import { describe, expect, it } from "vitest";
import { MANIFEST_LIMITS } from "@palimvo/plugin-sdk";
import { inspectPackage } from "./package.ts";
import { file, samplePackage } from "./testing.ts";

const codes = async (files: Parameters<typeof inspectPackage>[0]) => {
  try {
    await inspectPackage(files, { palimvoVersion: "0.1.0" });
    return [];
  } catch (err) {
    const details = (err as { details?: { issues?: { code: string }[] } }).details;
    return details?.issues?.map((i) => i.code) ?? ["thrown"];
  }
};

describe("inspectPackage", () => {
  it("accepts a package and hashes every file", async () => {
    const a = await inspectPackage(samplePackage(), { palimvoVersion: "0.1.0" });
    expect(a.manifest.id).toBe("board");
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    // One byte anywhere gives another hash.
    const b = await inspectPackage(
      samplePackage("board", "1.0.0", {}, "export default () => { };"),
    );
    expect(b.sha256).not.toBe(a.sha256);
    const withReadme = await inspectPackage([...samplePackage(), file("README.md", "hi")]);
    expect(withReadme.sha256).not.toBe(a.sha256);
  });

  it("requires every file the manifest points at", async () => {
    expect(await codes([samplePackage()[0]!])).toEqual(["missing_file"]);
    const themed = samplePackage("themed", "1.0.0", {
      contributes: { theme: { name: "Dark", css: "theme.css" } },
    });
    expect(await codes(themed)).toEqual(["missing_file"]);
    expect(await codes([...themed, file("theme.css", ":root{}")])).toEqual([]);
    const server = samplePackage("tools", "1.0.0", {
      server: "server.js",
      contributes: {
        tools: [{ name: "go", description: "Go", inputSchema: { type: "object" } }],
      },
    });
    expect(await codes(server)).toEqual(["missing_file"]);
    expect(await codes([...server, file("server.js", "globalThis.__plugin={tools:{}}")])).toEqual(
      [],
    );
  });

  it("checks locale files are JSON objects", async () => {
    const files = samplePackage("l", "1.0.0", { locales: { en: "locales/en.json" } });
    expect(await codes([...files, file("locales/en.json", "{")])).toEqual(["locale_not_json"]);
    expect(await codes([...files, file("locales/en.json", "[]")])).toEqual(["locale_not_object"]);
    expect(await codes([...files, file("locales/en.json", '{"a":"b"}')])).toEqual([]);
  });

  it("rejects a missing or broken manifest", async () => {
    expect(await codes([file("main.js", "x")])).toEqual(["missing_manifest"]);
    expect(await codes([file("manifest.json", "{"), file("main.js", "x")])).toEqual([
      "manifest_not_json",
    ]);
    expect(await codes([file("manifest.json", "{}"), file("main.js", "x")])).not.toEqual([]);
    expect(await codes([])).toEqual(["empty_package"]);
  });

  it("limits the number of files and the total size", async () => {
    const many = [
      ...samplePackage(),
      ...Array.from({ length: MANIFEST_LIMITS.packageFiles }, (_, i) => file(`f${i}.txt`, "x")),
    ];
    expect(await codes(many)).toContain("too_many_files");
    const big = [
      ...samplePackage(),
      { path: "big.bin", bytes: new Uint8Array(MANIFEST_LIMITS.packageBytes) },
    ];
    expect(await codes(big)).toContain("package_too_large");
  });

  it("refuses unsafe, hidden and colliding paths", async () => {
    for (const bad of [
      "../x.js",
      "/abs.js",
      ".hidden",
      "a//b.js",
      "a\\b.js",
      "sp ace.js",
      "a/.git/x",
    ]) {
      expect(await codes([...samplePackage(), file(bad, "x")])).toContain("invalid_file_path");
    }
    expect(await codes([...samplePackage(), file("MAIN.js", "x")])).toContain("duplicate_file");
    expect(await codes([...samplePackage(), file("main.js/x", "x")])).toContain("file_is_folder");
  });

  it("refuses a plugin that needs a newer Palimvo", async () => {
    const files = samplePackage("new", "1.0.0", { minPalimvo: "9.0.0" });
    expect(await codes(files)).toContain("incompatible");
  });
});
