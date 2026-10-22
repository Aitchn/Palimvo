# Search, backlinks and the link graph

`apps/server/src/search/` answers three kinds of question about a vault's contents. Every answer
comes from the vault service's in-memory file cache, so a query scans memory instead of reading
thousands of files.

## API

All routes are under `/api/vaults/:vault` and read-only.

| Route                                 | Answer                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /search?q=&limit=&offset=&path=` | `SearchPage`: `total` matches, one page of `hits` (path, `titleMatch`, up to 3 matching lines). `limit` is 1–200 (default 50); `path` restricts the search to a folder.                  |
| `GET /backlinks?path=`                | `{ backlinks }`: files that link to or embed `path`, with the linking lines (none for canvases).                                                                                         |
| `GET /links?path=`                    | `{ links }`: what `path` links to, each target once; `path: null` for a link whose target does not exist.                                                                                |
| `GET /graph`                          | `{ nodes, edges, unresolved }` for every note, canvas and base. Edges are deduplicated per pair of files; an embed edge becomes a plain edge when the same two files also link normally. |

The shared types (`SearchPage`, `Backlink`, `OutLink`, `GraphData`) live in `@palimvo/core`
(`packages/core/src/search.ts`).

## Query language

A query is split at whitespace into terms, all of which must occur (in the file's name or its
text), case-insensitively. A phrase in double quotes is one term: `"big picture" plan`. There are no
operators beyond that. Chinese needs no spaces: `決策` finds any file containing those two
characters. Only notes, canvases and bases are searched; for a canvas, the text of its text nodes
and the labels of groups and edges.

Results are ordered by: every term in the name first, then the number of occurrences (up to 10 per
term), then path.

## Design

- `SearchIndex` (`search/index.ts`) is the interface the server codes against. `MemorySearchIndex`
  is the only implementation in 0.1.0. For each file version it keeps the lower-cased text and a
  8192-bit set of the character pairs in it; a term whose pairs are not all in the set cannot occur
  in the file, which rules out most files without scanning them. Pairs work for any script, which
  word splitting does not for Chinese.
- A persistent index (SQLite FTS5 with the `trigram` tokenizer) is planned for 0.2. A trigram index
  **cannot find anything shorter than 3 characters**, which includes the two-character Chinese words
  that are the most common queries. `SearchIndex.supports(query)` says whether an index can answer
  and `withFallback(primary, fallback)` sends the other queries to the in-memory index, so the
  switch needs no change to the routes.
- `LinkIndex` reads the links of a file once per version (wikilinks and embeds outside code
  fences and inline code, for canvases also the files of its file nodes) and resolves them once per
  file list, the way Obsidian does (`resolveWikiLink` in `@palimvo/core`).
- Nothing here checks who may read what yet; that arrives with accounts (T10) and the permission
  resolver (T51). Pass `SearchOptions.include` to hide paths from a search.

## Performance

`pnpm --filter @palimvo/server bench:search` builds a 10,000-note vault of English and Chinese
notes and times queries. The first search after start derives every file (a few seconds for 10,000
notes); later queries take 15–40 ms, a backlink query about 130 ms and the whole link graph about
40 ms (Linux, Node 22). The script exits 1 when a warm search takes more than 100 ms or the graph
more than 1 s.
