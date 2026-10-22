# Vault files

A vault is a folder under `<data dir>/vaults/<id>/` holding plain files that Obsidian can open.
Palimvo keeps its own settings in the hidden `.palimvo/` folder inside it. Removed vaults move to
`<data dir>/trash/vaults/<id>-<UTC timestamp>/` and can be restored.

All access goes through `VaultService` (`apps/server/src/vault/service.ts`).

## Writing

- A write goes to a hidden temp file in the same folder, is fsynced, then renamed over the target.
  A crash leaves the old or the new content, never a mix. Stale temp files are removed the first
  time a vault is opened.
- Every file has a **version**: the first 16 hex digits of the SHA-256 of its bytes. Writes may
  carry a `baseVersion`; if the file is no longer at that version (`null` means "must not exist")
  the write fails with `409 version_conflict` and `details.current` holds the latest content.
  Leave `baseVersion` out to overwrite.
- Writes to one file run one at a time; writes to different files run in parallel. Moves, deletes,
  batches and `exclusive()` tasks (history snapshots) run alone. Paths reached through different
  symlinks share one lock.
- A **batch** checks every version before changing anything, then installs the files and puts the
  earlier ones back if one fails. A crash in the middle of installing can leave some files
  written; each file is still whole.

## Reading

The file tree and the text of notes, canvases and bases are cached in memory. The cache is
invalidated after every write the service makes and by a file watcher for changes made outside
the app (an editor, git, a sync tool). On Linux each visible folder gets its own inotify watcher;
if the system runs out (`fs.inotify.max_user_watches`) the log says so and the vault is read
from the disk until the watcher can start again. A safety sweep every minute catches changes
the watcher missed. External changes are announced through `VaultService.onChange` with
`external: true`; a folder path means anything below it may have changed.

Names starting with a dot never appear in the tree. `.git`, `.palimvo` and the previous
product's `.aivault` cannot be reached through the file API.

## REST

| Method and path                                                            | Purpose                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/vaults`                                                          | list vaults                                                                    |
| `POST /api/vaults` `{id}`                                                  | create a vault                                                                 |
| `DELETE /api/vaults/:vault`                                                | move a vault to the trash                                                      |
| `GET /api/removed-vaults`                                                  | list the trash                                                                 |
| `POST /api/removed-vaults/:name/restore`                                   | restore a vault                                                                |
| `GET /api/vaults/:vault/files`                                             | file tree, with an `ETag` that changes only when files or folders appear or go |
| `GET /api/vaults/:vault/files/<path>`                                      | text of a file (`ETag` = version)                                              |
| `PUT /api/vaults/:vault/files/<path>` `{content, baseVersion?}`            | write a text file                                                              |
| `DELETE /api/vaults/:vault/files/<path>`                                   | delete a file or folder                                                        |
| `POST /api/vaults/:vault/folders` `{path}`                                 | create a folder                                                                |
| `POST /api/vaults/:vault/move` `{from, to}`                                | move or rename                                                                 |
| `POST /api/vaults/:vault/batch` `{writes: [{path, baseVersion, content}]}` | write several files together                                                   |

Errors are `{code, message, details?}`; see `packages/core/src/errors.ts`. Accounts and
permissions arrive with T10; until then the server listens on loopback only by default.

## Vaults from the previous product

The first time a vault is used, a `.aivault/` folder is renamed to `.palimvo/` (if both exist,
both are left alone and a warning is logged). `VaultHooks.legacyMetaRenamed` lets version history
commit the rename once it exists.

## Benchmark

`pnpm --filter @palimvo/server bench` generates 10,000 notes and times the tree and common
operations; it fails if the cached tree takes 50 ms or more.
