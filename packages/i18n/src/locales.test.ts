import { describe, expect, it } from "vitest";
import { SUPPORTED_LOCALES, compareLocale, flatten, locales, placeholders } from "./index.ts";

describe("placeholders", () => {
  it("extracts simple and plural arguments", () => {
    expect(placeholders("Hello, {name}")).toEqual(["name"]);
    expect(placeholders("{count, plural, one {# item} other {# items}}")).toEqual(["count"]);
    expect(placeholders("{n, plural, one {{who} has # file} other {{who} has # files}}")).toEqual([
      "n",
      "who",
    ]);
    expect(placeholders("no arguments")).toEqual([]);
  });
});

describe("locale files", () => {
  const reference = locales.en;

  it("ships every supported locale", () => {
    expect(Object.keys(locales).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it("has no empty messages", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, text] of Object.entries(flatten(locales[locale]))) {
        expect(text.trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  for (const locale of SUPPORTED_LOCALES.filter((l) => l !== "en")) {
    it(`${locale} has exactly the English keys`, () => {
      const report = compareLocale(reference, locales[locale]);
      expect(report.missing).toEqual([]);
      expect(report.extra).toEqual([]);
    });

    it(`${locale} uses the same placeholders as English`, () => {
      expect(compareLocale(reference, locales[locale]).placeholderMismatch).toEqual([]);
    });

    it(`${locale} only flags existing keys for review`, () => {
      const known = new Set(Object.keys(flatten(reference)));
      for (const key of compareLocale(reference, locales[locale]).review) {
        expect(known.has(key), key).toBe(true);
      }
    });
  }
});

describe("compareLocale", () => {
  it("reports missing, extra, mismatched and untranslated keys", () => {
    const report = compareLocale(
      { a: "Hello {name}", b: "Keep going", c: "Only here" },
      { "// review": ["a"], a: "你好 {who}", b: "Keep going", d: "extra" },
    );
    expect(report).toEqual({
      missing: ["c"],
      extra: ["d"],
      placeholderMismatch: ["a"],
      review: ["a"],
      untranslated: ["b"],
    });
  });
});
