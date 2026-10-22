import type { FileKind } from "./types.ts";

/** A line of a file that matched a search or holds a link. `line` counts from 1. */
export interface LineMatch {
  line: number;
  text: string;
}

export interface SearchHit {
  path: string;
  /** Every search term occurs in the file's name. */
  titleMatch: boolean;
  /** The first few lines that contain a term (empty when only the name matched). */
  matches: LineMatch[];
}

/** One page of search results; `total` counts every match, not just this page. */
export interface SearchPage {
  query: string;
  total: number;
  offset: number;
  limit: number;
  hits: SearchHit[];
}

/** A file that links to (or embeds) another one. */
export interface Backlink {
  path: string;
  /** Lines with the link; empty for canvases, which link through their nodes. */
  lines: LineMatch[];
}

/** A link written in a file: where it points, if that exists. */
export interface OutLink {
  /** The target as written, e.g. `Projects/Plan` for `[[Projects/Plan|the plan]]`. */
  target: string;
  /** The file it resolves to; null when no such file exists (yet). */
  path: string | null;
  embed: boolean;
}

export interface GraphNode {
  path: string;
  /** The file name without its extension. */
  title: string;
  kind: FileKind;
}

export interface GraphEdge {
  from: string;
  to: string;
  embed: boolean;
}

/** Notes, canvases and bases of a vault and the links between them, for a graph view. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Links whose target does not exist. */
  unresolved: { from: string; target: string }[];
}

/**
 * The words of a search query, lower-cased: split at whitespace, and a phrase in double quotes
 * stays together. Used by the server to search and by the interface to highlight.
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.toLowerCase().matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim();
    if (term !== "") terms.push(term);
  }
  return terms;
}
