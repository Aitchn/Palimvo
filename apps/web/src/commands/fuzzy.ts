const BOUNDARY = /[\s/\\._\-()[\]]/;

/**
 * How well `query` matches `text`, or `null` when it does not match. Every space-separated word
 * of the query must appear in the text as a subsequence, in any order. Matches in the file name
 * (the part after the last "/"), at the start of words and in unbroken runs score higher; longer
 * file names score slightly lower. Case, accents and width are ignored; works for any script.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const words = query.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const haystack = text.normalize("NFKC").toLowerCase();
  const nameStart = haystack.lastIndexOf("/") + 1;
  let total = 0;
  for (const word of words) {
    const inName = subsequence(word, haystack, nameStart);
    const score = inName === null ? subsequence(word, haystack, 0) : inName + 40;
    if (score === null) return null;
    total += score;
  }
  // Shorter file names beat longer ones; folders count for little.
  return total - (haystack.length - nameStart) * 0.2 - nameStart * 0.02;
}

/** Greedy left-to-right match of `word` in `text` from `from`; `null` when it is not a subsequence. */
function subsequence(word: string, text: string, from: number): number | null {
  const chars = [...word];
  let at = from;
  let score = 0;
  let previous = -2;
  for (const char of chars) {
    const found = text.indexOf(char, at);
    if (found < 0) return null;
    score += 1;
    if (found === previous + 1) score += 5; // unbroken run
    if (found === from || BOUNDARY.test(text[found - 1] ?? "")) score += 3; // start of a word
    previous = found;
    at = found + char.length;
  }
  // The whole word as one piece is worth a lot more than the same letters spread out.
  if (text.indexOf(word, from) >= 0) score += 10;
  return score;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** The best `limit` items for `query`, best first. An empty query keeps the given order. */
export function rank<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
  limit = 50,
): T[] {
  if (query.trim() === "") return items.slice(0, limit);
  const scored: Ranked<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, text(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
