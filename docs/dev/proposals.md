# Edit proposals

An AI that may only propose, or a person who may not write, describes changes to notes; a person
with the review right accepts or rejects them one hunk at a time. Design: ADR 0015.

Code: `apps/server/src/proposals/proposals.ts` (service), `apps/server/src/routes/proposals.ts`
(REST), `apps/web/src/proposals/` (sidebar list and review dialog). Tests:
`apps/server/test/proposals.test.ts`, `apps/web/src/proposals/*.test.*`,
`tests/e2e/proposals.spec.ts`.

## REST

All routes are under `/api/vaults/:vault/proposals`.

| Method and path                   | Needs                                                        | Does                                                        |
| --------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| `GET /`                           | `proposal.create` or `proposal.review`                       | Summaries, newest first; `?state=all` includes decided ones |
| `GET /:id`                        | same                                                         | The proposal with every hunk and each file's status         |
| `POST /`                          | `proposal.create`                                            | Stores a proposal under the authenticated author            |
| `POST /:id/accept`, `/:id/reject` | `proposal.review` on every file's folder, a signed-in person | Decides hunks                                               |

Creating (the author is never taken from the body):

```json
{
  "title": "Move the launch",
  "rationale": "The vendor is late.",
  "sources": [{ "path": "Vendor.md", "label": "Vendor email" }],
  "files": [
    {
      "path": "Plan.md",
      "baseRevision": "0123456789abcdef",
      "hunks": [{ "before": "June", "after": "September", "rationale": "New date" }]
    }
  ]
}
```

`baseRevision` is the `version` from `GET /files/<path>` (`null` to create a file). A hunk is either
`{ before, after }` (`before` must occur exactly once; empty `before` only for an empty or new
file) or `{ start, end, before, after }` with UTF-16 offsets into that exact text. Limits: 5 MiB per
proposal, 100 files, 200 hunks per file.

Deciding:

```json
{ "version": 1, "hunkIds": ["…"] }
```

`version` is the proposal version the reviewer saw; leave `hunkIds` out to decide every hunk still
waiting. Errors: `proposal_changed` (409, reload and retry), `proposal_stale` (409, a note changed
after it was proposed; only reject), `version_conflict` (creating against an old version),
`invalid_request` (the text is not where the hunk says, overlap, a canvas that would not parse).

## Stored form

`.palimvo/proposals/<uuid>.json`, `schemaVersion: 1`. Excluded from git. Delete a file to forget a
proposal; nothing else refers to it. `applying` is present only while an accept is being written.

## History

Accepted changes are committed under the proposing author with the proposal title as the reason,
plus a `Palimvo-Approved-by: human:<name>` trailer. `CommitInfo.approvedBy` carries it to the
history API and the web app.
