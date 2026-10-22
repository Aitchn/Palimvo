import {
  fileKind,
  noteTitle,
  parseCanvas,
  searchTerms,
  type FileContent,
  type LineMatch,
  type SearchHit,
  type SearchPage,
} from "@palimvo/core";
import { eachFile, type FileSource } from "./files.ts";
import type { SearchIndex, SearchOptions } from "./index.ts";

const MAX_LINES_PER_FILE = 3;
const MAX_LINE_LENGTH = 200;
/** Occurrences counted per term when ranking; more adds nothing. */
const MAX_COUNTED = 10;

/** What a search needs from one file version, worked out once per version. */
interface Searchable {
  /** The text that is searched (a canvas's labels and texts, else the file). */
  text: string;
  lower: string;
  /** Which character pairs occur in `lower`; see {@link pairBits}. */
  pairs: Uint32Array;
}

/**
 * Searches the files of a vault in memory. Files come from the vault service's cache, and what a
 * query needs from a file (lower-cased text, a bit set of its character pairs) is worked out once
 * per file version, so a query over thousands of notes is a scan of memory instead of disk reads.
 * It answers every query, including one or two characters (Chinese words are often two).
 */
export class MemorySearchIndex implements SearchIndex {
  private readonly derived = new WeakMap<FileContent, Searchable>();
  private readonly titles = new WeakMap<readonly string[], Map<string, string>>();

  constructor(private readonly source: FileSource) {}

  supports(): boolean {
    return true;
  }

  async search(vault: string, query: string, options: SearchOptions): Promise<SearchPage> {
    const { limit, offset } = options;
    const terms = searchTerms(query);
    const page = (total: number, hits: SearchHit[]): SearchPage => ({
      query,
      total,
      offset,
      limit,
      hits,
    });
    if (terms.length === 0) return page(0, []);

    const termPairs = terms.map(pairsOfTerm);
    const all = await this.source.list(vault);
    const titles = this.titlesOf(all);
    const folder = options.folder ? `${options.folder.replace(/\/+$/, "")}/` : "";
    const paths = all.filter(
      (p) => (folder === "" || p.startsWith(folder)) && (options.include?.(p) ?? true),
    );

    const found: { path: string; titleMatch: boolean; score: number; text?: string }[] = [];
    await eachFile(this.source, vault, paths, (path, file) => {
      const title = titles.get(path) ?? noteTitle(path).toLowerCase();
      const titleMatch = terms.every((t) => title.includes(t));
      let text: string | undefined;
      let score = 0;
      if (file) {
        const s = this.searchable(path, file);
        let all = true;
        for (let i = 0; i < terms.length; i++) {
          const t = terms[i]!;
          const inContent = mayContain(s.pairs, termPairs[i]!) && s.lower.includes(t);
          if (inContent) score += countOccurrences(s.lower, t);
          else if (!title.includes(t)) all = false;
        }
        if (all) text = s.text;
      }
      if (titleMatch || text !== undefined) found.push({ path, titleMatch, score, text });
    });

    found.sort(
      (a, b) =>
        Number(b.titleMatch) - Number(a.titleMatch) ||
        b.score - a.score ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    // Matching lines only for the results that are returned.
    const hits = found.slice(offset, offset + limit).map(({ path, titleMatch, text }) => ({
      path,
      titleMatch,
      matches:
        text === undefined
          ? []
          : matchingLines(text, (line) => terms.some((t) => line.includes(t))),
    }));
    return page(found.length, hits);
  }

  private searchable(path: string, file: FileContent): Searchable {
    let s = this.derived.get(file);
    if (!s) {
      const text = fileKind(path) === "canvas" ? canvasText(file.content) : file.content;
      const lower = text.toLowerCase();
      // Most CJK text has no case: share the string instead of keeping a second copy.
      s = { text, lower: lower === text ? text : lower, pairs: pairBits(lower) };
      this.derived.set(file, s);
    }
    return s;
  }

  /** Lower-cased note titles, worked out once per file list. */
  private titlesOf(paths: readonly string[]): Map<string, string> {
    let titles = this.titles.get(paths);
    if (!titles) {
      titles = new Map(paths.map((p) => [p, noteTitle(p).toLowerCase()]));
      // Only a frozen list stays the same; any other would never hit again.
      if (Object.isFrozen(paths)) this.titles.set(paths, titles);
    }
    return titles;
  }
}

const PAIR_BITS = 8192;

/**
 * A fixed-size bit set of the character pairs in `text`: a file whose set lacks one of a search
 * term's pairs cannot contain the term, so most files are ruled out without scanning their text.
 * (Works for any script, CJK included, unlike splitting into words.)
 */
export function pairBits(text: string): Uint32Array {
  const bits = new Uint32Array(PAIR_BITS / 32);
  for (let i = 0; i + 1 < text.length; i++) {
    const h = pairHash(text.charCodeAt(i), text.charCodeAt(i + 1));
    bits[h >>> 5]! |= 1 << (h & 31);
  }
  return bits;
}

function pairHash(a: number, b: number): number {
  return (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b)) >>> 19; // 13 bits
}

/** The pair hashes of a search term (none for one character: nothing to rule out). */
export function pairsOfTerm(term: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < term.length; i++)
    out.push(pairHash(term.charCodeAt(i), term.charCodeAt(i + 1)));
  return out;
}

export function mayContain(bits: Uint32Array, pairs: readonly number[]): boolean {
  for (const h of pairs) if (!(bits[h >>> 5]! & (1 << (h & 31)))) return false;
  return true;
}

function countOccurrences(text: string, term: string): number {
  let n = 0;
  for (
    let at = text.indexOf(term);
    at >= 0 && n < MAX_COUNTED;
    at = text.indexOf(term, at + term.length)
  )
    n++;
  return n;
}

/** Searchable text of a canvas: its text nodes and group/edge labels, one per line. */
function canvasText(source: string): string {
  try {
    const canvas = parseCanvas(source);
    return [
      ...canvas.nodes.map((n) =>
        n.type === "text" ? n.text : n.type === "group" ? (n.label ?? "") : "",
      ),
      ...canvas.edges.map((e) => e.label ?? ""),
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

function matchingLines(content: string, test: (lowerLine: string) => boolean): LineMatch[] {
  const out: LineMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && out.length < MAX_LINES_PER_FILE; i++) {
    const line = lines[i]!;
    if (test(line.toLowerCase()))
      out.push({ line: i + 1, text: line.trim().slice(0, MAX_LINE_LENGTH) });
  }
  return out;
}
