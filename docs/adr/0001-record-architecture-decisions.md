# 0001. Record architecture decisions

- Status: accepted
- Date: 2026-10-21

## Context

Palimvo is a fresh, public rewrite of an earlier private project. Contributors need to see why
the system is built the way it is, including which choices were inherited and which are new.

## Decision

We record significant decisions as short ADRs in `docs/adr/`, numbered from 0001, written in
English, using [the template](0000-template.md). A pull request that departs from an accepted ADR
adds a new ADR that supersedes it.

This ADR also records the initial technical defaults (D1–D10) and the key decisions carried over
from the earlier project.

### Initial technical defaults

| #   | Decision                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Node 24 LTS is the minimum version; CI also tests Node 26.                                                                                                                                                                                                                            |
| D2  | Server-level data (accounts, sessions, AI tokens, OAuth, audit log, plugin library index, server settings) lives in SQLite via `node:sqlite` in one `palimvo.db` file. Vault content stays as plain files and git, never in the database. Pending validation spike S1 (see ADR 0002). |
| D3  | The server is compiled to a single esbuild bundle (`dist/palimvo.mjs`); production does not run TypeScript sources.                                                                                                                                                                   |
| D4  | Plugin server-side logic (MCP tools) runs in a QuickJS (WebAssembly) sandbox with memory and time limits and only declared vault permissions. Pending validation spike S2 (see ADR 0003).                                                                                             |
| D5  | i18n uses i18next and react-i18next; locale files live in `packages/i18n/locales/{en,zh-TW,zh-CN}.json`. The server returns error codes plus an English message; the web app translates by code. MCP tool descriptions are English only.                                              |
| D6  | Versions and changelogs use Changesets; all packages share one version.                                                                                                                                                                                                               |
| D7  | Git operations use the git CLI (the Docker image bundles git).                                                                                                                                                                                                                        |
| D8  | Search in 0.1.0 reuses the in-memory index; a persistent full-text index (SQLite FTS5 trigram) is planned for 0.2 behind an abstract `SearchIndex` interface.                                                                                                                         |
| D9  | Package scope is `@palimvo/*`; only the plugin SDK is intended for npm.                                                                                                                                                                                                               |
| D10 | Documentation, ADRs, code comments, and commit messages are in English.                                                                                                                                                                                                               |

### Decisions carried over from the earlier project

- **Files are the source of truth.** Notes are Markdown, canvases are JSON Canvas, databases are
  Obsidian Bases files. A vault opens in Obsidian unchanged.
- **Live merging with Yjs.** Humans and AIs edit the same document at the same time; edits from
  REST and MCP are applied to the live document instead of overwriting it.
- **One git commit per author.** Each vault is a git repository; changes are committed per author
  (human or named AI client) with the stated reason, so history answers who changed what and why.
- **Plugins run only after hash approval.** A person approves the exact content hash of a plugin;
  any change requires approval again. Plugin UI runs in a sandboxed iframe.

## Consequences

Decisions are discoverable and can be challenged with a superseding ADR. Writing the defaults
down now lets the spikes (S1, S2) change them through a normal ADR instead of silently.

## Alternatives considered

Keeping decisions only in issue threads or a single design document: harder to find and to
supersede individually.
