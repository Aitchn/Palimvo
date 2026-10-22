import type { SearchPage } from "@palimvo/core";
import { MemorySearchIndex } from "./memory.ts";
import { LinkIndex } from "./links.ts";
import { vaultFileSource, type FileSource } from "./files.ts";
import type { VaultService } from "../vault/service.ts";

export interface SearchOptions {
  limit: number;
  offset: number;
  /** Only search below this folder. */
  folder?: string;
  /** Only search paths it accepts (applied before results are counted and paged). */
  include?: (path: string) => boolean;
}

/**
 * Full-text search over one vault. The server uses it only through this interface, so a
 * persistent index (SQLite FTS5, planned for 0.2) can replace {@link MemorySearchIndex}.
 */
export interface SearchIndex {
  /**
   * Whether this index can answer `query`. An FTS5 trigram index cannot find anything shorter
   * than 3 characters (a two-character Chinese word, for one); {@link withFallback} sends such
   * queries to another index.
   */
  supports(query: string): boolean;
  search(vault: string, query: string, options: SearchOptions): Promise<SearchPage>;
}

/** Answers with `primary` when it can, else with `fallback` (which must answer every query). */
export function withFallback(primary: SearchIndex, fallback: SearchIndex): SearchIndex {
  return {
    supports: () => true,
    search: (vault, query, options) =>
      (primary.supports(query) ? primary : fallback).search(vault, query, options),
  };
}

/** Everything the server can look up about the contents and links of its vaults. */
export interface VaultIndexes {
  search: SearchIndex;
  links: LinkIndex;
}

export function createVaultIndexes(
  vaults: VaultService,
  options: { search?: (source: FileSource) => SearchIndex } = {},
): VaultIndexes {
  const source = vaultFileSource(vaults);
  const memory = new MemorySearchIndex(source);
  return {
    search: options.search ? withFallback(options.search(source), memory) : memory,
    links: new LinkIndex(source),
  };
}

export { LinkIndex } from "./links.ts";
export { MemorySearchIndex } from "./memory.ts";
export type { FileSource } from "./files.ts";
