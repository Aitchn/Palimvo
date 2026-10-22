# 0010. The editor reads its text from a note session

- Status: accepted
- Date: 2026-10-22

## Context

The build plan (T17) binds the Markdown editor to the live Yjs document that the collaboration server (T16) provides. T16 is not in `main` yet, but the editor has to ship in the web app now so that notes can be written at all.

## Decision

`MarkdownSurface` accepts one of two sources: a plain string with an `onChange` callback, or a shared `Y.Text` with an `Awareness` (y-codemirror.next: merged typing, per-user undo, remote cursors with names and colours). `NoteEditor` gets its source from a `NoteSession` (`source`, `status`, `peers`, `notice`, `resolve`, `retry`). Until T16 lands, the default session reads the note over HTTP and saves after a 0.8 s pause with `baseVersion`, so a newer version is never overwritten: a `version_conflict` stops saving and shows a choice (use theirs, keep mine). Text that was typed but not saved is kept in `localStorage` (`palimvo.unsent:<vault>:<path>`) and restored on the next open, and closing the page with unsaved text asks first.

T16 adds a second session (`useCollabNote`) that returns a `collab` source; `NoteEditor` already accepts it through its `session` prop, and cursor identity helpers (`collab/presence.ts`) exist for it.

Widgets that CodeMirror draws outside React (copy button, embed placeholder, diagram messages, the properties toggle) read their text from an `editorLabels` facet that React fills from i18next, so they follow the interface language.

## Consequences

- Notes are editable now, one writer at a time per note; simultaneous editing across tabs arrives with T16 without changing the editor.
- Until T16, two people typing in the same note meet a conflict choice instead of a merge.
- Base (`.base`) and component embeds, plugin code blocks and canvas text cards are not part of this editor yet (T21, T22, T33, T20); their hooks were left out rather than carried over unused.

## Alternatives considered

- Wait for T16. It would leave the app without a way to edit notes, and the surface is easier to review without the network layer.
- Build a throwaway local Yjs session in the browser. Extra code that T16 replaces, with no benefit over HTTP saving.
