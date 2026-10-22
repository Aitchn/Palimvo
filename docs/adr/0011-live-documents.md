# 0011. Notes and canvases are edited through live documents on the server

- Status: accepted
- Date: 2026-10-22

## Context

People and AIs edit the same note at the same time (build plan T16). Saving whole files with a version check (ADR 0010's HTTP session) turns every overlap into a conflict, and an AI that writes through the REST API would either fail or overwrite what people just typed.

## Decision

While anyone has a note (`.md`) or canvas (`.canvas`) open, the server keeps one Yjs document for it (`CollabHub`, `apps/server/src/collab/`). That document is the source of truth until the last client leaves and the idle timer (30 s) runs out.

- **Transport.** y-websocket protocol at `/api/collab/<room>?vault=<id>&path=<file>[&lineage=<id>]`. The room name is ignored; vault and path identify the document. A page on another origin is refused (`X-Forwarded-Host` is honoured only with `PALIMVO_TRUST_PROXY`). Access checks plug in through `attachCollab`'s `authorize` callback; accounts (T10) will provide it. Until then the same trust as the REST API applies.
- **Document layout.** Markdown is one `Y.Text`. A canvas keeps nodes and edges in maps keyed by id plus an order array, so edits to different cards merge. Both live in `@palimvo/core` (`collab.ts`), shared with the web app.
- **Saving.** The file follows the document 1 s after the last edit and at least every 5 s while edits keep coming (`persistDelayMs`, `persistMaxDelayMs`). A write that finds the file changed on disk meanwhile keeps both: the live text becomes the file, the other text is saved as `name (conflict <timestamp>).ext`. Shutdown flushes every live document before history makes its last commit, so a clean stop loses nothing. After a crash (kill -9, power loss) at most the last `persistMaxDelayMs` of typing is lost.
- **REST writes merge.** `PUT /files/*`, batches and restores of a note that has a live document are applied to it as a minimal text diff, so concurrent typing survives. A write whose `baseVersion` is older than the live document still gets `version_conflict`, carrying the current text, exactly like a write to a file without a live document. Reads of such a file come from the document, so they are never staler than the screen.
- **Edits made outside the app** (Obsidian, git pull) are adopted by an idle live document once the new version has stayed the same for two consecutive checks (3 s apart), so a program that writes in several steps is not read halfway.
- **Deleting and moving** a file or folder first writes unsaved edits (moves) and closes its documents with code 4404; clients show "not found". Removing a vault flushes, then closes all its documents.
- **History.** Every connection's edits are credited to the author behind it (the name the editor shares for its cursor until accounts exist, then the signed-in account); an AI that writes through REST is credited by `X-Palimvo-Author`. Credits are recorded while the vault's write queue is held, as for any other write.
- **Lineage.** Rebuilding a document from text gives its characters new internal ids; a client that still holds the old document would then duplicate the text when it reconnects. The server therefore saves each document's Yjs state in `.palimvo/collab/` (excluded from git) together with the file version it matches and a random `lineage` id stored inside the document. A client sends the lineage it holds when it reconnects; a mismatch closes the socket with 4409 instead of merging. The web session then restarts from the server's copy, and saves text typed in the meantime as a separate note (`name (offline <timestamp>).md`).
- **Web.** `useCollabNote` returns the same `NoteSession` as the HTTP session, with a `collab` source, so `NoteEditor` is unchanged apart from choosing the session (`live`, default on; `live={false}` keeps the HTTP session). The editor appears after the first sync; it never shows an empty document that then fills.

## Consequences

- Two browsers and an AI can write the same note at once and all edits survive (Playwright e2e against the built server).
- Typing while disconnected stays in the page and merges on return. It is not kept across a page reload yet: the IndexedDB cache and the offline queue are T19. Closing the page with such text asks first.
- Live documents are memory held per open file; idle ones are released after 30 s.
- Canvas editing (T20) and proposals (T27+) use the same hub; nothing in the hub is specific to Markdown.
- The hub's REST path holds a per-file lock above the vault's write queue. Batches, moves, deletes and vault removal take the vault-wide lock, which waits for single-file writes first.

## Alternatives considered

- **Keep HTTP saving and resolve conflicts by hand.** Simple, but two people typing in one note would constantly collide, and an AI could not edit a note people have open.
- **Operational transforms or a CRDT library other than Yjs.** Yjs is what `y-codemirror.next` binds to and what the old project already ran in production.
- **Persist Yjs updates instead of the Markdown file.** Faster to save, but the vault would stop being plain files that Obsidian and git can use.
