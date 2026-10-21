import en from "../locales/en.json" with { type: "json" };
import zhCN from "../locales/zh-CN.json" with { type: "json" };
import zhTW from "../locales/zh-TW.json" with { type: "json" };
import type { Locale } from "./negotiate.ts";

export const PACKAGE = "@palimvo/i18n";

export * from "./negotiate.ts";
export * from "./check.ts";

export const locales: Record<Locale, import("./check.ts").Messages> = {
  en,
  "zh-TW": zhTW,
  "zh-CN": zhCN,
};
