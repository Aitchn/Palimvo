import { beforeEach, describe, expect, it } from "vitest";
import {
  currentTheme,
  initTheme,
  readPreference,
  setThemePreference,
  themePreference,
} from "./theme.ts";

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("theme", () => {
  it("follows the device when nothing is saved", () => {
    expect(readPreference()).toBe("system");
  });

  it("moves the previous product's key to the new one, once", () => {
    localStorage.setItem("aitchn.theme", "light");
    expect(readPreference()).toBe("light");
    expect(localStorage.getItem("palimvo.theme")).toBe("light");
    expect(localStorage.getItem("aitchn.theme")).toBeNull();
  });

  it("prefers the new key over the old one", () => {
    localStorage.setItem("palimvo.theme", "dark");
    localStorage.setItem("aitchn.theme", "light");
    expect(readPreference()).toBe("dark");
  });

  it("applies and saves a choice", () => {
    initTheme();
    setThemePreference("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(currentTheme()).toBe("light");
    expect(themePreference()).toBe("light");
    expect(localStorage.getItem("palimvo.theme")).toBe("light");
    setThemePreference("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
