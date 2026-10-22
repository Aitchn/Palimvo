# 0018. Plugin installation, approval and the library

- Status: accepted
- Date: 2026-10-22

## Context

Plugins run code that people wrote in other people's vaults, so who may install one, who may let
it run, and what exactly was approved all matter. T30 gave us the manifest, the validator and a
content hash over every file of a package. T32 uses them on the server: installing into a vault,
approving, switching on, dependencies, and a server-wide library that administrators publish to
and owners install from. The previous version stored approvals next to the plugin files in the
vault and let an AI install a plugin through a plain write token.

## Decision

- **Files in the vault, state in the database.** An installed plugin's files live in
  `<vault>/.palimvo/plugins/<id>/`, so they are versioned and backed up with the vault. Which
  package is installed (id, version, hash, manifest), whether it is switched on, and every
  approval live in `palimvo.db` (`vault_plugins`, `plugin_approvals`). Approvals are not written
  into the vault: a vault copied or restored onto another server, or edited by someone who can
  write files, cannot bring its own approvals with it.
- **Approval is bound to the hash and to a person.** An approval row is (vault, plugin, hash).
  The route needs a signed-in session with `plugin.approve`; bearer secrets (API tokens, OAuth
  grants) are refused, and the MCP tools have no approve action. Approving also re-hashes the
  files on disk and refuses when they differ from the installed package or when the hash the
  person was shown is no longer the installed one. Reinstalling the same bytes is approved
  already; any other bytes are not.
- **Switching on is separate from approving.** A new install is off. An update keeps the switch,
  so an enabled plugin whose new hash is not approved reports `needs_approval` and does not run,
  instead of silently turning off or on.
- **Running is computed.** `running` = on, approved, and all `dependencies` run at accepted
  versions; a cycle runs nothing (`resolveDependencies`, pure and tested). Runtimes call
  `PluginManager.load`, which re-hashes the files every time, so the check does not rely on
  the database alone. A plugin's rights at run time are the manifest's declaration intersected
  with the acting person's (`pluginMayAccess`).
- **Package limits are checked at the door.** File count and total size use `MANIFEST_LIMITS`
  (200 files, 8 MiB), paths are restricted to a safe alphabet without hidden segments or
  case-only collisions, every file the manifest names must exist, and locale files must be JSON
  objects. Problems are returned together as `plugin_invalid`.
- **Library.** Packages are stored once under `<data>/library/plugins/<id>/<version>/` with an
  index row; a version is immutable (publishing it again is a conflict), and reading one back
  re-hashes it against the recorded hash. Official plugins from the repository are added at
  start; folders that fail the checks are skipped with a warning (the five official plugins have
  only manifests until T35/T36) and official entries cannot be removed.
- **MCP.** Read-only tools (`list_plugins`, `list_library_plugins`, `read_plugin`) need only
  `vault.view`. Tokens never carry `plugin.install` (ADR 0013), so the tools that change plugins
  (`install_plugin`, `install_library_plugin`, `set_plugin_enabled`, `uninstall_plugin`,
  `publish_library_plugin`, `remove_library_plugin`) use the administration flag of ADR 0015:
  only an OAuth grant the person allowed to administer sees them, with the person's own rights.
  An AI can therefore propose a plugin, but only a person makes it run.

## Consequences

- Moving a vault between servers means approving its plugins again; that is intended.
- Hashing on every `load` costs a read of at most 8 MiB per request; hosts should cache the
  loaded package per hash.
- Uninstall deletes the approvals; the files stay in the vault's history.
- ZIP upload and the library/approval screens are not part of this change (T31/T33 and the
  settings screens use the API added here).

## Alternatives considered

- **Approvals in the vault's config.** Simple and portable, but anyone able to write files could
  forge them, and a vault restored from a backup would run code nobody on this server approved.
- **Letting write tokens install plugins** (as before). Convenient, but then "an AI cannot run
  code" rests only on the approval step; keeping install behind the administration flag adds a
  second lock.
- **Re-hashing only at approval time.** Cheaper, but a file edited on disk afterwards would run
  under an old approval.
