# 0017. Vault home and activity wall

- Status: accepted
- Date: 2026-10-22

## Context

Task T26: opening a vault with no file selected used to show an empty "no file open" message. The
product's point is accountability, so the first screen should say what changed lately, who (or
which AI) changed it, and what still waits for a person's decision.

## Decision

- **Settings** live in `.palimvo/home.json` (`schemaVersion` 1): an ordered list of `widgets`,
  the `pinned` note paths, and an optional `publicNote` ("start here"). The file is versioned in
  the vault's git history like `config.json`, so a change to the page has an author and a reason.
  A vault without the file shows the default page: proposals, activity, pinned notes.
- **Widget types** are `activity`, `proposals`, `pinned`, `base` (a link card to a `.base` file)
  and `plugin` (an interface only; plugin views render once the plugin host exists, T31). New
  types are added with a schema version bump and a migration.
- **Saving** uses a content version of the stored file as `baseVersion` (`null` for "no file
  yet"); a mismatch answers `version_conflict`. A damaged or hand-edited file shows the default
  page instead of failing; saving then replaces it.
- **Permissions**: reading needs `vault.view`; changing needs `vault.settings`; the activity wall
  needs `history.view`. The proposals block is fed by the existing proposals API and therefore
  needs `proposal.create` or `proposal.review`. The web hides blocks the person cannot read.
- **Activity wall**: `GET …/home/activity?filter=all|human|ai&limit=` looks at the latest 200
  commits. Changes that only touched `.palimvo/…` are left out (they would drown real work), a
  commit without files (a checkpoint) stays. `ai` includes plugins acting for an AI. The response
  also lists every author active in the window, ignoring the filter, so the filter chips can show
  counts. Grouping by author is done by the web app.
- **Guests** may `GET …/home` (only that endpoint): they receive the `pinned` and `base` blocks
  filtered by the public policy, and `publicNote` only when it is itself public. They get no
  activity or proposals.

## Consequences

- Database widgets are links for now; an inline table view arrives with the Bases screen (T21).
- Activity for very large vaults is bounded by the 200-commit window; "load more" can be added
  without an API change by raising `limit` (capped at 100 entries per response today).
