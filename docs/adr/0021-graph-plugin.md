# 0021. The graph plugin, `vault.graph` and the inspector slot

- Status: accepted
- Date: 2026-10-22

## Context

T55 asks for an official plugin that draws the vault's link graph on a page, stays usable with
10,000 notes, and shows the neighborhood of the open note in a side panel. Three things were
missing: plugins could not read the link graph, the graph endpoint had neither tags nor a way to
ask for part of the graph, and no plugin could put anything in the side panel.

## Decision

- **`palimvo.vault.graph({ around?, depth?, tags? })`** is a new plugin API (RPC `vault.graph`).
  The host asks `GET /graph` with the person's own session and then keeps only files inside the
  plugin's `permissions.read` and links whose two ends both qualify, the same filtering rule
  `list`, `search` and database rows already follow. `around` must itself be readable.
- **`GET /graph` gets two optional parameters** (additive, the default answer is unchanged so the
  MCP `get_graph` tool is not affected): `tags=1` puts a note's tags on its node and
  `around=<path>&depth=<1..6>` returns only the neighborhood. The side panel asks for the
  neighborhood so a 10,000-note vault does not ship its whole graph on every note change.
- **A new `inspector` slot** draws a plugin section in the details panel, in a sandboxed frame under
  a heading the app owns, like `settings`. The frame is kept while files change and receives the new
  `path` through the existing `update` message. There is no `visible` round trip: it would remount
  the frame on every file change.
- **The plugin is one `main.js`** because the host loads only the manifest's `main`. Its pure parts
  (model, layout, picking) are exported for unit tests; the drawing is covered by an e2e test.
- **Layout and drawing.** A force simulation with a Barnes-Hut quadtree (flat typed arrays, O(n log n)
  per step, fewer steps for big vaults) runs on the frame's main thread within a per-frame time
  budget. Drawing is a 2D canvas with one stroke per link class and one fill per color, culling of
  off-screen parts and labels for the best connected notes in view only. While a big picture is
  panned or zoomed, the last full drawing is moved as an image and redrawn when movement stops.
  Dragging a note in a big picture moves its neighbors directly instead of waking the whole layout.
- **Tags are nodes only when asked for and only if used by two or more notes**, otherwise every
  note would add a leaf and bury the structure.

## Not done

- Coloring by role ("身分組") is not offered: the graph API carries no per-note role or owner. Folder,
  tag and file type are available.
- The layout is not persisted; each opening settles again (about a second of visible movement for
  10,000 notes).

## Consequences

- Other plugins (a map, a mind map) can use `vault.graph` and the `inspector` slot.
- A WebGL renderer or a persisted layout can replace the canvas drawing later without API changes.
