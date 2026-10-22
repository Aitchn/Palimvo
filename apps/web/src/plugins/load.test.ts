import { describe, expect, it } from "vitest";
import { assemble } from "./load.ts";

const manifest = {
  manifestVersion: 2,
  id: "demo",
  version: "1.0.0",
  name: { en: "Demo" },
  locales: { en: "locales/en.json", "zh-TW": "locales/zh-TW.json" },
  contributes: { theme: { name: "Night", css: "theme.css" } },
};
const info = { id: "demo", version: "1.0.0", hash: "a".repeat(64), manifest };
const bundle = (over: Record<string, unknown> = {}) => ({
  id: "demo",
  hash: "a".repeat(64),
  files: {
    "main.js": "export default () => {}",
    "locales/en.json": '{"hello":"Hello","nested":{"no":"x"},"n":1}',
    "locales/zh-TW.json": "not json",
    "theme.css": ":root{--accent:red}",
  },
  ...over,
});

describe("assemble", () => {
  it("builds a runnable plugin from the listing and the bundle", () => {
    const plugin = assemble(info, bundle());
    expect(plugin.code).toBe("export default () => {}");
    expect(plugin.hash).toBe("a".repeat(64));
    // Only flat string tables count; a broken file is an empty table, not a failure.
    expect(plugin.locales).toEqual({ en: { hello: "Hello" }, "zh-TW": {} });
    expect(plugin.themeCss).toBe(":root{--accent:red}");
  });

  it("refuses a bundle whose hash is not the listed one", () => {
    expect(() => assemble(info, bundle({ hash: "b".repeat(64) }))).toThrow(/changed/);
  });

  it("refuses a bundle for another plugin", () => {
    expect(() => assemble(info, bundle({ id: "other" }))).toThrow(/changed/);
  });

  it("refuses a manifest that does not match the listing", () => {
    expect(() => assemble({ ...info, version: "2.0.0" }, bundle())).toThrow(/does not match/);
  });

  it("refuses an invalid manifest", () => {
    expect(() =>
      assemble({ ...info, manifest: { ...manifest, manifestVersion: 1 } }, bundle()),
    ).toThrow(/manifest/);
  });

  it("refuses a bundle without its main file", () => {
    const files = { ...bundle().files } as Record<string, string>;
    delete files["main.js"];
    expect(() => assemble(info, bundle({ files }))).toThrow(/main\.js is missing/);
  });
});
