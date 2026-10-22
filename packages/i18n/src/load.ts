import type { Messages } from "./check.ts";
import type { Locale } from "./negotiate.ts";

/**
 * Loads one locale's messages on demand. Each locale is its own chunk in the web build, so a
 * visitor downloads only the language they use (plus English as the fallback).
 */
export async function loadLocale(locale: Locale): Promise<Messages> {
  switch (locale) {
    case "zh-TW":
      return (await import("../locales/zh-TW.json", { with: { type: "json" } })).default;
    case "zh-CN":
      return (await import("../locales/zh-CN.json", { with: { type: "json" } })).default;
    default:
      return (await import("../locales/en.json", { with: { type: "json" } })).default;
  }
}
