/**
 * Plugin themes are the one place a plugin's text reaches the app's own styles, so it is not
 * trusted: the stylesheet is parsed here and only a small, harmless subset is passed on. A theme
 * may set custom properties (`--name: value`) and a few look-and-feel properties, on `:root` and
 * the light/dark selectors, and nothing else. Anything that could fetch something, run something
 * or restyle a specific element is dropped, never "fixed up".
 */

/** Properties besides `--*` a theme may set. */
export const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set([
  "color-scheme",
  "font-family",
  "font-size",
  "line-height",
  "letter-spacing",
]);

/**
 * Selectors a rule may have (compared after whitespace and quote normalisation) and what each is
 * written as. The app's own tokens sit on `:root[data-theme="…"]`; a theme must beat them without
 * `!important`, so every selector is written with that specificity and, being injected later in
 * the page, wins the tie.
 */
const ALLOWED_SELECTORS: ReadonlyMap<string, string> = new Map([
  [":root", ":root:root"],
  [':root[data-theme="light"]', ':root[data-theme="light"]'],
  [':root[data-theme="dark"]', ':root[data-theme="dark"]'],
  ['[data-theme="light"]', ':root[data-theme="light"]'],
  ['[data-theme="dark"]', ':root[data-theme="dark"]'],
]);

/** A custom property name; `--` alone and escapes are refused. */
const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]+$/;

/** Longest value kept; real tokens are a few dozen characters. */
const MAX_VALUE_LENGTH = 400;
export const MAX_THEME_BYTES = 64 * 1024;

/**
 * Words that make a value unsafe. Escapes are refused outright (`u\72l(` spells `url(`), as are
 * comments inside a value, `;`/braces (they would end the declaration), `<` and `>`, and every
 * function that can load a resource or run script.
 */
const FORBIDDEN_VALUE =
  /\\|\/\*|\*\/|[{};<>@]|url\s*\(|image-set\s*\(|image\s*\(|cross-fade\s*\(|element\s*\(|src\s*\(|expression\s*\(|javascript:|vbscript:|data:|behaviou?r|binding|!\s*important/i;

export interface ThemeReport {
  css: string;
  /** What was dropped and why, for the plugin settings. */
  dropped: string[];
}

function normaliseSelector(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([[\]=])\s*/g, "$1")
    .replace(/'/g, '"');
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** The value is plain enough to put into a stylesheet as it is. */
export function isSafeValue(value: string): boolean {
  const v = value.trim();
  if (v === "" || v.length > MAX_VALUE_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  return !FORBIDDEN_VALUE.test(v);
}

/**
 * Keeps the allowed rules of a theme stylesheet and returns them re-serialised. A stylesheet that
 * is too large, an `@` rule, a nested block, an unknown selector or property, or a value that is
 * not plain is dropped (and reported), the rest is kept.
 */
export function sanitizeThemeCss(input: string): ThemeReport {
  const dropped: string[] = [];
  if (input.length > MAX_THEME_BYTES) {
    return { css: "", dropped: ["the stylesheet is larger than 64 KB"] };
  }
  const text = stripComments(input);
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    // A statement at-rule (`@import "x";`) has no block: skip it up to its semicolon.
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (text[i] === "@") {
      const semicolon = text.indexOf(";", i);
      const brace = text.indexOf("{", i);
      if (semicolon !== -1 && (brace === -1 || semicolon < brace)) {
        dropped.push(`at-rule "${text.slice(i, i + 40).split(/[\s(;]/)[0] ?? "@"}"`);
        i = semicolon + 1;
        continue;
      }
    }
    const open = text.indexOf("{", i);
    if (open === -1) {
      if (text.slice(i).trim() !== "") dropped.push("text after the last rule");
      break;
    }
    const selector = normaliseSelector(text.slice(i, open));
    // The block runs to the first closing brace; a second opening brace first means nesting.
    const close = text.indexOf("}", open + 1);
    if (close === -1) {
      dropped.push(`unterminated rule "${selector.slice(0, 40)}"`);
      break;
    }
    const body = text.slice(open + 1, close);
    if (body.includes("{")) {
      // Skip the whole nested construct: from here to its matching brace.
      let depth = 0;
      let end = open;
      for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}" && --depth === 0) break;
      }
      dropped.push(`nested rule "${selector.slice(0, 40)}"`);
      i = end + 1;
      continue;
    }
    i = close + 1;
    if (selector.startsWith("@")) {
      dropped.push(`at-rule "${selector.slice(0, 40)}"`);
      continue;
    }
    const selectors = selector.split(",").map(normaliseSelector);
    const written = selectors.map((s) => ALLOWED_SELECTORS.get(s));
    if (written.some((s) => s === undefined)) {
      dropped.push(`selector "${selector.slice(0, 60)}"`);
      continue;
    }
    const declarations: string[] = [];
    for (const piece of body.split(";")) {
      if (piece.trim() === "") continue;
      const colon = piece.indexOf(":");
      if (colon === -1) {
        dropped.push("a declaration without a colon");
        continue;
      }
      const rawName = piece.slice(0, colon).trim();
      // Custom property names are case sensitive; the others are not.
      const property = rawName.startsWith("--") ? rawName : rawName.toLowerCase();
      const value = piece.slice(colon + 1).trim();
      const okName = CUSTOM_PROPERTY.test(property) || ALLOWED_PROPERTIES.has(property);
      if (!okName) {
        dropped.push(`property "${property.slice(0, 40)}"`);
        continue;
      }
      if (!isSafeValue(value)) {
        dropped.push(`value of "${property}"`);
        continue;
      }
      declarations.push(`${property}:${value}`);
    }
    if (declarations.length > 0)
      out.push(`${[...new Set(written)].join(",")}{${declarations.join(";")};}`);
  }
  return { css: out.join("\n"), dropped };
}
