# 0021. The Decisions plugin keeps decision records as plain notes and works through file names first

- Status: accepted
- Date: 2026-10-22

## Context

Decisions are no longer part of the core (ADR 0001). The official `decisions` plugin owns the
format and the four MCP tools. Its tools run in the QuickJS sandbox (ADR 0003): one call may make
200 `vault` calls, sees only the folders its manifest names, and cannot see who is calling. Version 1
of the product kept the same records in core code with none of these limits.

## Decision

- **Records are notes**: `NNNN-title.md` in any folder called `decisions/`, frontmatter `status`,
  `date`, `deciders`, `related`, `supersedes`, `requires`, `tree`, `branch`. The folder decides the
  tree unless `tree:` overrides it; numbers count per folder. The format is the one version 1 wrote,
  so existing vaults need no migration (a test reads version 1 notes, Chinese headings included).
  New records use English section headings unless the caller asks for `zh-TW` or `zh-CN`.
- **Permissions are `**/decisions/**`** for read and write. A tree may live in `decisions/<tree>/`
  or `<tree>/decisions/`, so a fixed `decisions` folder would miss the second. The plugin cannot
  read any note outside a decision folder, and the caller's own rights still apply.
- **Recording and status changes work from file names.** The next number, the tree's folder and
  `Tree#0003` references need only the paths, so they cost one `vault.list` however many records
  exist. Only the two list tools read files, at most 150 per call, and report `truncated`; asking
  for one `tree` reads that tree first.
- **No overwriting.** `record_decision` reads the target path first and moves to the next number
  when it exists. Two calls at the same instant can still pick the same number (the host offers no
  create-only write); different titles keep both files and the reply warns.
- **Reason and author come from the registry.** The tools declare neither `reason` nor an author:
  the registry demands a `reason` for the two writing tools and the history credits the plugin acting
  for the AI client. `deciders` stays empty unless given, since the sandbox does not know the caller.
- **Tool names** stay `record_decision`, `list_decisions`, `update_decision_status`,
  `list_decision_trees` (seen by clients as `decisions.<tool>`).

## Consequences

- A vault with more than 150 decision records needs a `tree` filter to see all of them through the
  tools; the timeline (T37) will read through the browser API and has no such limit.
- The same parsing code is needed in the browser entry for T37. It is not shared yet because
  `server.js` must be one file; T37 may copy it or add a tool that returns parsed records.
