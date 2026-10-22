import { describe, expect, it } from "vitest";
import { computePluginHash, PLUGIN_HASH_PATTERN, type PluginFile } from "./hash.ts";

const enc = new TextEncoder();
const file = (path: string, text: string): PluginFile => ({ path, bytes: enc.encode(text) });
const pkg = [file("manifest.json", "{}"), file("main.js", "export default () => {}")];

describe("computePluginHash", () => {
  it("returns a SHA-256 hex digest that does not depend on file order", async () => {
    const a = await computePluginHash(pkg);
    expect(a).toMatch(PLUGIN_HASH_PATTERN);
    expect(await computePluginHash([...pkg].reverse())).toBe(a);
  });

  it("is pinned to the documented rule", async () => {
    // Computed independently (Python hashlib) from the rule in hash.ts; a different value would
    // invalidate every approval already given.
    expect(await computePluginHash([file("manifest.json", "{}")])).toBe(
      "eefcac810e566d9b39e4459b60ceb24cf447a8e1db39fb46c83916b1dba1faac",
    );
  });

  it("changes when a single byte, a path, or the file set changes", async () => {
    const original = await computePluginHash(pkg);
    const flipped = pkg.map((f) => ({ path: f.path, bytes: f.bytes.slice() }));
    (flipped[1] as PluginFile).bytes[0] = (flipped[1] as PluginFile).bytes[0]! ^ 1;
    expect(await computePluginHash(flipped)).not.toBe(original);
    expect(
      await computePluginHash([pkg[0]!, file("other.js", "export default () => {}")]),
    ).not.toBe(original);
    expect(await computePluginHash([...pkg, file("README.md", "")])).not.toBe(original);
  });

  it("cannot be confused by moving bytes between files", async () => {
    const a = await computePluginHash([file("manifest.json", "ab"), file("x", "c")]);
    const b = await computePluginHash([file("manifest.json", "a"), file("x", "bc")]);
    expect(a).not.toBe(b);
  });

  it("does not normalize line endings", async () => {
    const lf = await computePluginHash([file("manifest.json", "{\n}")]);
    const crlf = await computePluginHash([file("manifest.json", "{\r\n}")]);
    expect(lf).not.toBe(crlf);
  });

  it("refuses bad packages", async () => {
    await expect(computePluginHash([file("main.js", "")])).rejects.toThrow(/manifest\.json/);
    await expect(computePluginHash([...pkg, file("main.js", "")])).rejects.toThrow(/Duplicate/);
    for (const path of ["../x", "/x", "a\\b", "a//b", "./x", ""]) {
      await expect(computePluginHash([...pkg, file(path, "")]), path).rejects.toThrow(/Invalid/);
    }
  });
});
