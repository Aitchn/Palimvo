export const SUPPORTED_LOCALES = ["en", "zh-TW", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const TRADITIONAL = new Set(["tw", "hk", "mo", "hant"]);
const SIMPLIFIED = new Set(["cn", "sg", "hans"]);

/** Maps one BCP 47 tag to a supported locale, or undefined when we do not ship it. */
export function matchTag(tag: string): Locale | undefined {
  const parts = tag.trim().toLowerCase().replace(/_/g, "-").split("-");
  const lang = parts[0];
  if (lang === "en") return "en";
  if (lang !== "zh") return undefined;
  for (const part of parts.slice(1)) {
    if (TRADITIONAL.has(part)) return "zh-TW";
    if (SIMPLIFIED.has(part)) return "zh-CN";
  }
  // Bare "zh" is conventionally Simplified.
  return "zh-CN";
}

function parseAcceptLanguage(header: string): string[] {
  return header
    .split(",")
    .map((entry, index) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const qParam = params.find((p) => /^\s*q\s*=/i.test(p));
      const q = qParam === undefined ? 1 : Number(/^\s*q\s*=\s*([\d.]+)\s*$/i.exec(qParam)?.[1]);
      return { tag: tag.trim(), q, index };
    })
    .filter((e) => e.tag && e.tag !== "*" && e.q > 0 && !Number.isNaN(e.q))
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((e) => e.tag);
}

/**
 * Picks the best supported locale from an Accept-Language header or a
 * `navigator.languages` style list. The first preference we ship wins;
 * everything else falls back to English.
 */
export function negotiate(preferred: string | readonly string[] | null | undefined): Locale {
  if (!preferred) return DEFAULT_LOCALE;
  const tags = typeof preferred === "string" ? parseAcceptLanguage(preferred) : preferred;
  for (const tag of tags) {
    const match = matchTag(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
