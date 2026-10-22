# 0015. Edit proposals

- Status: accepted
- Date: 2026-10-22

## Context

An AI that may only propose (a token with the "propose" level, or any member whose role denies
writing) must be able to say "I would change these notes like this" without touching them, and a
person must be able to accept some of it. The previous version did this with an atomic
transaction journal, a request id for every review and its own file-writing layer. The new vault
layer already writes several files as one checked batch (`writeBatch`), so most of that is not
needed any more.

## Decision

- **Data.** One JSON file per proposal in `.palimvo/proposals/<uuid>.json` (`schemaVersion` 1,
  read through the shared migrator). It holds the title, rationale, sources, the proposing author,
  and per file a `baseRevision` (the version the proposal was written against; `null` for a new
  file) and its hunks. A hunk keeps its UTF-16 offsets in the base text, the text before and after,
  its own rationale, a little context from both sides (so it can be shown after the file moved on)
  and its review state. The folder is excluded from git: proposals are working state, not history.
- **Clients may leave out offsets.** `before` is then located in the file and must occur exactly
  once, which is how a language model naturally describes an edit. Offsets are checked against the
  text when given. Hunks must not overlap, must change something, and canvases and bases must
  still parse after the change. Only notes, canvases and bases can be proposed.
- **Accepting is one batch.** The service re-reads every file the chosen hunks touch, requires its
  version to equal `baseRevision` (otherwise `proposal_stale`, nothing is written), computes the
  new texts, and writes them with `VaultService.writeBatch`, which checks all versions before
  writing anything. A partial accept moves the base revision of the file to what was written and
  shifts the offsets of hunks still waiting, so a later accept applies cleanly.
- **Who is credited.** The history records the change under the proposing author with the
  proposal's title as the reason, and a new `Palimvo-Approved-by` trailer names the person who
  accepted it (also on `CommitInfo.approvedBy`). The history panel shows "Approved by …".
- **Staleness is computed, not stored.** Whenever a proposal is read, each file with hunks still
  waiting is compared with its base revision: `current`, `stale` (changed) or `missing`. A stale
  hunk can only be rejected; the proposer makes a new proposal. Rebasing a hunk onto changed text
  is deliberately not attempted: guessing where an AI's edit belongs in text it never saw is how
  silent corruption happens.
- **Concurrency.** Reviews of one proposal run one at a time. The client sends the proposal
  `version` it saw; a changed proposal or an already decided hunk is `proposal_changed` (409).
  There is no separate request id: after an uncertain network failure the client reloads the
  proposal and sees what was decided.
- **Interrupted accepts are finished, not forgotten.** Before the batch is written the record
  gets an `applying` entry (the reviewer, each file's hunk ids and the version it will have). If
  the server stops after the notes were written but before the record was updated, the next read
  sees that a file now has exactly that version and completes the bookkeeping; files that did not
  make it keep their hunks pending.
- **Permissions.** Reading and creating need `proposal.create` (or `proposal.review` to read); the
  list and details are hidden from guests because proposals quote private notes. Accepting and
  rejecting need `proposal.review` on the folder of every file touched (a folder may take it
  away), and are refused for AI tokens whatever their owner may do. `proposal.review` is part of
  the vault administrator set, not of the default member set (ADR 0011).
- **Live documents.** `ProposalService` takes the writer as `writeBatch`, the same call the REST
  batch route uses. When the collaboration server (T16) routes batches through its live documents,
  proposals follow without changes.

## Consequences

- No new file-writing code and no journal to recover; the price is that a crash in the middle of
  `writeBatch` (documented there) can leave some files written, which the `applying` entry
  repairs on the next look.
- A member's own AI token can propose, but only someone with `proposal.review` can accept. A
  later task can add "the token's owner may review proposals made through their own token".
