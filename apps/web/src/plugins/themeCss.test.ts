import { describe, expect, it } from "vitest";
import { MAX_THEME_BYTES, isSafeValue, sanitizeThemeCss } from "./themeCss.ts";

describe("sanitizeThemeCss", () => {
  it("keeps custom properties on :root and the light/dark selectors", () => {
    const { css, dropped } = sanitizeThemeCss(`
      /* a comment */
      :root { --accent: #6c8cff; --Bg-Side : rgb(1, 2, 3); color-scheme: dark }
      :root[data-theme='light'] { --bg: #fff; }
      [data-theme="dark"], :root[data-theme="dark"] { --fg: var(--fg-strong, #eee); font-family: "Inter", sans-serif; }
    `);
    expect(css).toBe(
      [
        ":root:root{--accent:#6c8cff;--Bg-Side:rgb(1, 2, 3);color-scheme:dark;}",
        ':root[data-theme="light"]{--bg:#fff;}',
        ':root[data-theme="dark"]{--fg:var(--fg-strong, #eee);font-family:"Inter", sans-serif;}',
      ].join("\n"),
    );
    expect(dropped).toEqual([]);
  });

  it.each([
    ["url()", "--x: url(https://evil.example/a.png)"],
    ["url() with whitespace", "--x: url (https://evil.example/a.png)"],
    ["escaped url", "--x: u\\72l(https://evil.example/a.png)"],
    ["image-set", "--x: image-set('a.png' 1x)"],
    ["expression", "--x: expression(alert(1))"],
    ["javascript:", "--x: javascript:alert(1)"],
    ["data:", "--x: data:text/html,hi"],
    ["@import in a value", "--x: @import 'a.css'"],
    ["!important", "--x: red !important"],
    ["angle brackets", "--x: </style><script>"],
    ["a control character", "--x: red\u0000"],
    ["an empty value", "--x:"],
    ["a huge value", `--x: ${"a".repeat(500)}`],
  ])("drops a value with %s", (_name, declaration) => {
    const { css } = sanitizeThemeCss(`:root { ${declaration}; --ok: 1px; }`);
    expect(css).toBe(":root:root{--ok:1px;}");
  });

  it.each([
    ["background", "background: red"],
    ["position", "position: fixed"],
    ["behavior", "behavior: url(x.htc)"],
    ["-moz-binding", "-moz-binding: url(x)"],
    ["content", 'content: "x"'],
    ["a bare name", "--"],
    ["an escaped name", "--a\\62"],
    ["no colon", "color"],
  ])("drops the property %s", (_name, declaration) => {
    const { css, dropped } = sanitizeThemeCss(`:root { ${declaration}; --ok: 1px }`);
    expect(css).toBe(":root:root{--ok:1px;}");
    expect(dropped.length).toBeGreaterThan(0);
  });

  it.each([
    ["an element selector", "body { --x: 1 }"],
    ["a class selector", ".main { --x: 1 }"],
    ["an attribute selector that reads content", 'input[value^="a"] { --x: 1 }'],
    ["a universal selector", "* { --x: 1 }"],
    ["a selector list with one bad member", ":root, body { --x: 1 }"],
    ["a descendant selector", ":root .main { --x: 1 }"],
    ["a pseudo-element", ":root::before { --x: 1 }"],
  ])("drops a rule with %s", (_name, rule) => {
    expect(sanitizeThemeCss(`${rule} :root { --ok: 1 }`).css).toBe(":root:root{--ok:1;}");
  });

  it("drops at-rules, nested blocks and anything after them without touching the rest", () => {
    const { css, dropped } = sanitizeThemeCss(`
      @import url("https://evil.example/x.css");
      @font-face { font-family: x; src: url(https://evil.example/f.woff2) }
      @media (min-width: 1px) { :root { --leak: 1 } }
      :root { --kept: 1 }
      :root { --nested: 1; & .main { color: red } }
      :root { --after: 2 }
    `);
    expect(css).toContain(":root:root{--kept:1;}");
    expect(css).toContain(":root:root{--after:2;}");
    expect(css).not.toMatch(/import|font-face|media|leak|nested|evil|url/);
    expect(dropped.length).toBeGreaterThanOrEqual(3);
  });

  it("skips a statement at-rule up to its semicolon and keeps the rules after it", () => {
    const { css, dropped } = sanitizeThemeCss(
      '@import url("https://evil.example/x.css");@charset "x"; :root { --a: 1 }',
    );
    expect(css).toBe(":root:root{--a:1;}");
    expect(dropped).toEqual(['at-rule "@import"', 'at-rule "@charset"']);
  });

  it("returns nothing for an oversized stylesheet, unterminated rules and plain text", () => {
    expect(sanitizeThemeCss(`:root{--x:${"a".repeat(MAX_THEME_BYTES)}}`).css).toBe("");
    expect(sanitizeThemeCss(":root { --x: 1").css).toBe("");
    expect(sanitizeThemeCss("hello").css).toBe("");
    expect(sanitizeThemeCss("").css).toBe("");
  });

  it("treats comments as whitespace and a stray brace as the end of the rule", () => {
    expect(sanitizeThemeCss(":root { --x: re/* url(a) */d }").css).toBe(":root:root{--x:re d;}");
    const { css } = sanitizeThemeCss(":root { --x: a} body { background: red } ");
    expect(css).toBe(":root:root{--x:a;}");
  });

  it("never emits a character that could end the style element or the rule early", () => {
    const { css } = sanitizeThemeCss(
      `:root { --a: x; --b: </style><img src=x onerror=alert(1)>; --c: y }`,
    );
    expect(css).toBe(":root:root{--a:x;--c:y;}");
    expect(css).not.toMatch(/[<>]/);
  });
});

describe("isSafeValue", () => {
  it("accepts ordinary values and refuses empty ones", () => {
    expect(isSafeValue("#fff")).toBe(true);
    expect(isSafeValue("12px")).toBe(true);
    expect(isSafeValue("color-mix(in srgb, var(--a) 40%, white)")).toBe(true);
    expect(isSafeValue("  ")).toBe(false);
  });
});
