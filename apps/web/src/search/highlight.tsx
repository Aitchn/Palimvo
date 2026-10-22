import type { ReactNode } from "react";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with every occurrence of one of `terms` (already lower-case) wrapped in `<mark>`. */
export function highlight(text: string, terms: readonly string[]): ReactNode {
  const wanted = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (wanted.length === 0) return text;
  const parts = text.split(new RegExp(`(${wanted.map(escape).join("|")})`, "i"));
  // split() with one capture group puts the matches at the odd positions.
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}
