import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_CODE_LIST } from "@palimvo/core";
import { flatten, locales } from "@palimvo/i18n";
import { chooseLocale, createI18n, initialLocale, setLocale } from "./index.ts";

describe("initialLocale", () => {
  beforeEach(() => vi.stubGlobal("navigator", { languages: ["zh-Hant-TW", "en"] }));
  afterEach(() => vi.unstubAllGlobals());

  it("follows the browser language list", () => {
    expect(initialLocale()).toBe("zh-TW");
  });

  it("falls back to English when the browser asks for nothing we ship", () => {
    vi.stubGlobal("navigator", { languages: ["fr-FR", "de"] });
    expect(initialLocale()).toBe("en");
  });

  it("prefers the saved choice", () => {
    localStorage.setItem("palimvo.locale", "zh-CN");
    expect(initialLocale()).toBe("zh-CN");
  });

  it("ignores a saved value that is not a locale", () => {
    localStorage.setItem("palimvo.locale", "klingon");
    expect(initialLocale()).toBe("zh-TW");
  });
});

describe("switching language", () => {
  it("loads only the locales in use and changes text, plurals and <html lang>", async () => {
    const i18n = await createI18n("en");
    expect(i18n.hasResourceBundle("zh-TW", "translation")).toBe(false);
    expect(i18n.t("common.itemCount", { count: 1 })).toBe("1 item");
    expect(i18n.t("common.itemCount", { count: 3 })).toBe("3 items");
    expect(document.documentElement.lang).toBe("en");

    await setLocale("zh-TW", i18n);
    expect(i18n.hasResourceBundle("zh-TW", "translation")).toBe(true);
    expect(i18n.hasResourceBundle("zh-CN", "translation")).toBe(false);
    expect(i18n.t("common.save")).toBe("儲存");
    expect(i18n.t("common.itemCount", { count: 3 })).toBe("3 個項目");
    expect(document.documentElement.lang).toBe("zh-TW");
  });

  it("keeps the latest choice when an earlier download finishes last", async () => {
    const i18n = await createI18n("en");
    const first = setLocale("zh-TW", i18n);
    const second = setLocale("zh-CN", i18n);
    await Promise.all([second, first]);
    expect(i18n.language).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("remembers the choice", async () => {
    await chooseLocale("zh-CN", await createI18n("en"));
    expect(localStorage.getItem("palimvo.locale")).toBe("zh-CN");
  });
});

describe("messages the shell relies on", () => {
  it("has a translated message for every server error code", () => {
    for (const [name, messages] of Object.entries(locales)) {
      const flat = flatten(messages);
      for (const code of ERROR_CODE_LIST)
        expect(flat[`errors.${code}`], `${name}:${code}`).toBeTruthy();
      expect(flat["errors.network"], name).toBeTruthy();
      expect(flat["errors.unknown"], name).toBeTruthy();
    }
  });
});
