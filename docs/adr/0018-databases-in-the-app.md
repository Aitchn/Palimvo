# 0018. Databases (.base) in the app

- Status: accepted
- Date: 2026-10-22

## Context

The core package already parses Obsidian Bases files and runs them over a vault's notes
(`parseBase`, `queryBase`, `setNoteProperty`), and the MCP server exposes `query_base`. The web
app had no way to open a `.base` file, embed one in a note, or change a cell. The previous version
did this with a `POST /bases/query` endpoint and one large React component.

## Decision

- **Two routes**, both under `/api/vaults/:vault/bases/`:
  - `POST query` takes a `path` (a `.base` file) or a `source` (the YAML of a ` ```base ` block)
    with the note it lives in (`thisPath`), a `view` and optional `columns`. It answers with the
    core `BaseResult` and, for a file, the version it was read at. It needs `note.read`. It is a
    POST because the YAML travels in the body, but it only reads: guests may call it (the access
    gate lists it next to the GET reads) and see rows of public notes only, and links resolve only
    among the files they may see. A token limited to folders gets the same filtering.
  - `POST property` sets or removes one frontmatter property. It needs `note.write` on the note,
    queues edits per note and retries on `version_conflict`, so two people editing different cells
    of one note both win. The change is committed under the caller's name with a generated reason.
- **Settings are saved with the usual file write.** Sorting, grouping, filters, columns and views
  are edited by changing the parsed `BaseFile` and writing it back with `updateBaseSource` (which
  keeps the user's formatting where it can) through `PUT files/…` with the version that was read,
  so a concurrent change is reported (`version_conflict`) instead of overwritten. A ` ```base `
  block hands the new YAML back to the editor, which replaces the block's text; the note's own
  save and live editing carry it from there.
- **One `BaseView` component** serves the file view and the embeds in notes (`embedded` makes it
  compact). `![[name.base]]` lines and ` ```base ` blocks become a block widget with its own React
  root (`editor/baseEmbeds.tsx`); embedded read-only copies of notes do not show databases.
- **Refresh by polling** (every 10 seconds while the page is visible, again after an edit),
  because the server has no change stream yet. When it does, `BaseView` swaps the timer for it.
- **No browser dialogs.** Names for rows, views, properties and formulas are asked in dialogs that
  can be translated; file-field headings (`file.mtime`…) are translated, property names are not.
- **Plugin views are not drawn yet.** A view of type `plugin` (kept in the file as it is) shows a
  notice; it comes with the plugin runtime.
- **Card covers** are shown for web addresses only until vault files can be served as images.

## Consequences

- Querying reads every note of the vault through the in-memory file cache, as `query_base` does;
  a vault of tens of thousands of notes should get an indexed implementation behind the same route.
- Guests can make the server do that work with one POST each; a per-client limit on this route is a follow-up.
