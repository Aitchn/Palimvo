import { describe, expect, it } from "vitest";
import { negotiate } from "./index.ts";

describe("negotiate", () => {
  it("defaults to English", () => {
    expect(negotiate(undefined)).toBe("en");
    expect(negotiate("")).toBe("en");
    expect(negotiate([])).toBe("en");
    expect(negotiate("de-DE,fr;q=0.8")).toBe("en");
  });

  it.each([
    ["en-US", "en"],
    ["en", "en"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh", "zh-CN"],
    ["zh_tw", "zh-TW"],
    ["ZH-tw", "zh-TW"],
  ])("maps %s to %s", (tag, expected) => {
    expect(negotiate([tag])).toBe(expected);
    expect(negotiate(tag)).toBe(expected);
  });

  it("honours q-values and order in Accept-Language", () => {
    expect(negotiate("en;q=0.5, zh-TW;q=0.9")).toBe("zh-TW");
    expect(negotiate("zh-CN, zh-TW")).toBe("zh-CN");
    expect(negotiate("en;q=0, zh-CN;q=0.1")).toBe("zh-CN");
  });

  it("skips unsupported languages before falling back", () => {
    expect(negotiate("de, ja;q=0.9, zh-HK;q=0.8")).toBe("zh-TW");
    expect(negotiate(["fr-FR", "zh-SG", "en"])).toBe("zh-CN");
  });

  it("ignores wildcards and malformed q-values", () => {
    expect(negotiate("*")).toBe("en");
    expect(negotiate("zh-TW;q=abc, en;q=0.1")).toBe("en");
  });
});
