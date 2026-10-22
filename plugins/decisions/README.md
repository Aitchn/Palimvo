# Decisions

Records decisions as notes and gives AI clients four tools to read and write them. The timeline
page and panels come with the next release of this plugin.

## Format

A record is `NNNN-title.md` in any folder called `decisions/`, at any depth:

```
---
status: accepted          # proposed | accepted | superseded | rejected
date: 2026-10-22
deciders: [Aitchn, Claude]
related: [docs/plan.md]
supersedes: 0003          # number, path, [[link]] or Tree#0003
requires:                 # records this one needs, possibly in other trees
  - "[[Prism/decisions/0003-API-3.25]]"
tree: Prism               # only when the folder does not already say it
branch: "4.x"             # a line of decisions next to the main one
---

# 0004 Title

## Context / Options / Decision / Consequences
```

- **Trees.** The folder decides the tree: `decisions/Prism/0001-x.md` and `Prism/decisions/0001-x.md`
  are both tree `Prism`; `decisions/0001-x.md` is in no tree. A `tree:` field overrides that.
  Numbers count per folder.
- **Cross-tree `requires`.** Written as `[[links]]` when they resolve, so Obsidian shows them as links.
- **Compatible with version 1 data.** Notes written by the earlier Obsidian-Aitchn decision tools
  (including the Chinese section headings 背景 / 選項 / 決定 / 後果) are read as they are.

## Tools

They appear to AI clients as `decisions.<tool>` through `list_tools` / `call_tool`, only in vaults
where the plugin runs. Writes need a `reason`, which the history keeps.

| Tool                     | Does                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `record_decision`        | Files a new record in its tree's folder with the next number                             |
| `list_decisions`         | Lists records, optionally by `status` or `tree`, with `supersedesPath` / `requiresPaths` |
| `update_decision_status` | Changes `status` in place; the rest of the note is untouched                             |
| `list_decision_trees`    | Trees with their folders, counts by status and the trees they need                       |

## Limits

- Permissions are `**/decisions/**` for read and write: the plugin sees nothing outside decision
  folders, and the caller must still hold the rights there.
- A call may make 200 vault calls, so the list tools read at most 150 records and say
  `truncated: true` when there were more. Ask for one `tree` to see the rest.
- `record_decision` checks that the number is free just before it writes. Two records filed at the
  same instant in the same folder can still end up with the same number (different titles keep both
  files); the later reply carries a `warning`.
- `deciders` is empty unless given: the sandbox does not know who the caller is (the history does).
