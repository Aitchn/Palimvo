import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const markdownHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, fontWeight: "700", color: "var(--syn-heading)" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.monospace, fontFamily: "ui-monospace, monospace", color: "var(--syn-mono)" },
    { tag: tags.link, color: "var(--syn-link)" },
    { tag: tags.url, color: "var(--syn-url)" },
    { tag: tags.quote, color: "var(--syn-quote)" },
    {
      tag: [tags.processingInstruction, tags.meta, tags.contentSeparator],
      color: "var(--syn-meta)",
    },
    // Fenced code in other languages. Colours come from tokens.css so they follow the light/dark theme.
    {
      tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword],
      color: "var(--syn-keyword)",
    },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--syn-string)" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--syn-number)" },
    {
      tag: [tags.lineComment, tags.blockComment, tags.comment],
      color: "var(--syn-comment)",
      fontStyle: "italic",
    },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
      color: "var(--syn-function)",
    },
    { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syn-type)" },
    { tag: [tags.propertyName, tags.attributeName], color: "var(--syn-property)" },
    { tag: [tags.tagName, tags.angleBracket], color: "var(--syn-property)" },
    { tag: [tags.definition(tags.variableName), tags.self], color: "var(--syn-type)" },
    { tag: [tags.operator, tags.punctuation, tags.separator], color: "var(--syn-operator)" },
    { tag: tags.invalid, color: "var(--syn-invalid)" },
  ]),
);
