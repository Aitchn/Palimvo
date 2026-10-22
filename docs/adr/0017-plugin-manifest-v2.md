# 0017. Plugin manifest v2 and SDK

- Status: accepted
- Date: 2026-10-22

## Context

Obsidian-Aitchn plugins declared a flat manifest: three coarse permissions (`read`, `write`,
`network`) plus an optional folder scope, and the list of things they add (views, code blocks,
components, file types, viewers, extension points) as separate top-level fields. Palimvo adds
UI slots, themes, whole-page apps, home widgets, base views and server-side MCP tools, and it
runs plugins for people other than their author, so the manifest is also what a person reads
before approving a plugin. Three places need to agree on it: the web host, the server, and the
tools plugin authors run on their own machine.

## Decision

- **One package, no dependencies.** `@palimvo/plugin-sdk` holds the manifest types, the
  validator, folder-pattern matching, version ranges, the content hash, the v1 converter and the
  runtime API types. It uses only the platform (Web Crypto for hashing), so the browser, the
  server and a plugin author's CLI import the same code. The validator is hand-written rather
  than zod so that the SDK stays dependency-free and every issue has a stable code and path.
- **Strict manifest.** `manifestVersion: 2` is required. Unknown keys are errors, since a typo
  in a permission name must not silently grant nothing (or something else). The validator
  returns a normalized copy with defaults filled in, plus warnings for powerful requests
  (whole-vault write, unrestricted network) that the approval screen should highlight.
- **Permissions are data, not a list of words.** `permissions.read` and `.write` are folder
  patterns (a plain pattern is a folder prefix, `*` and `**` are wildcards, matching is exact
  for wildcard patterns); `network` is `false` or a list of host names, with `*` allowed but
  warned about. At run time the effective right is the manifest's declaration intersected with
  the acting person's permissions (T32).
- **Everything a plugin adds lives under `contributes`.** Views, code blocks,
  components, file types, viewers, base views, home widgets, extension points, extensions
  (contributions to another plugin's point, which must be a `dependency`), UI slots, a theme, a
  whole-page app, and server tools. Ids are checked for uniqueness, names the core owns (`md`,
  `mermaid`, `table`...) are reserved, and file types keep the old rule that nothing a browser
  could run as a page or program may be declared.
- **Text is localized in the manifest.** `name`, `description` and other display text are a
  string or a locale table that must contain `en`. Strings used while the plugin runs come from
  files named in `locales`. Tool descriptions are English only because they are written for AI
  clients.
- **Tools declare their schema.** Each `contributes.tools` entry carries a JSON Schema
  (`type: "object"`, at most 16 KB, `$ref` only inside the same document) that the server uses
  to validate arguments before the sandbox sees them. A plugin with tools needs a separate
  `server.js`; browser code and server code are never one file (S2, risk 3).
- **The hash covers the whole package.** The approved hash is SHA-256 over every file of the
  package (manifest, code, styles, locales, README), length-prefixed and sorted by path, bytes
  as stored. One changed byte anywhere means a new approval. The exact rule is written in
  `hash.ts` and pinned by a test whose expected value was computed independently.
- **v1 manifests convert, with notes.** `convertLegacyManifest` maps the old fields and returns
  notes for what changed meaning (the old `network` became `["*"]`, short versions were padded,
  scope paths with wildcards were dropped) so the importer (T42) can show them.

## Consequences

- T31 (browser host), T32 (install and approval) and T34 (server tools) build on one validator
  and one set of types instead of each re-reading the manifest.
- A manifest from a newer Palimvo with fields this version does not know is refused with
  `unknown_key` rather than half-understood; `minPalimvo` is the author's tool to avoid that.
- Hand-written validation has to be kept in step with the types; the tests cover every
  contribution kind and every refusal code to make that cheap.
- The official plugins' manifests live in `plugins/<id>/manifest.json` before their code does
  (T35, T36); the SDK tests validate them so the manifests cannot drift.

## Alternatives considered

- **zod schemas.** Good error messages, but a runtime dependency for the browser bundle and the
  plugin CLI, and the issue shape (stable code + path) would still need mapping.
- **Keeping the flat v1 shape and adding fields.** Cheaper, but the permission words cannot
  express folders or hosts, and a growing flat list hides what a plugin actually adds.
- **Hashing only `manifest.json` and the entry file.** Smaller, but styles, locales and any
  additional modules could change after approval.
