# Version history

Every vault is a git repository (the `git` command must be installed: 2.31 or newer; the server
refuses to start without it). Palimvo makes the commits itself, so people never have to.

## How changes become commits

- The file API tells `VaultHistory.record()` which paths a request changed, who made the request
  and, if given, why. This happens while the vault's write queue is still held, so a snapshot can
  never fall between a write and its author.
- `X-Palimvo-Author` (`ai:Claude Code`, URI-encoded) and `X-Palimvo-Reason` (URI-encoded) carry
  the author and reason. Until accounts arrive (T10) the author header is taken on trust; without
  it the change is credited to `human:Anonymous`. `X-Aivault-*` headers are still read.
- A commit happens `commitDelayMs` (10 s) after the last recorded change, or at the latest
  `commitMaxDelayMs` (60 s) after the first one. Pending changes are also committed on shutdown,
  before a checkpoint and before a vault is removed.
- One commit per author and set of stated reasons. The git author is the writer. Anyone else who
  touched the same files is a `Co-authored-by` trailer. The subject is the reason when there is
  one, otherwise a short description ("Update a.md", "Move a to b").
- Commit messages end in trailers: `Palimvo-Author: ai:Claude Code`, one `Palimvo-Reason: …` per
  distinct reason, `Palimvo-Checkpoint: true` for checkpoints.
- Anything changed outside the app (an editor, git, a sync tool) is committed as
  `external:External change`. The file watcher reports such edits and schedules that commit.
- A vault gets its first commit ("Create version history", by `external:Palimvo`) when it is
  created. For a vault that was copied in, the first commit is made lazily, but files the app has
  recorded since are left out of it and credited to their authors.
- A vault whose `.aivault/` folder was renamed to `.palimvo/` gets a commit "Rename .aivault to
  .palimvo" (the `legacyMetaRenamed` hook).

## What stays out

- `.palimvo/collab/`, `.palimvo/cache/`, `.palimvo/uploads/`, `.palimvo/tmp/` and crash leftovers
  (`.<name>.tmp-xxxxxxxx`) are listed in `.git/info/exclude`; the vault's own files are untouched.
  Settings, plugins and proposals in `.palimvo/` are versioned.
- Files over 100 MiB (`MAX_HISTORY_FILE_BYTES`) are excluded too, because git keeps every version
  for good and GitHub refuses files that large, which would stop every backup push. A tracked file
  that grows past the limit leaves the history in a commit of its own; the file itself stays.

## REST

| Method and path                                              | Purpose                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `GET /api/vaults/:vault/history?path=&limit=`                | commits, newest first; with `path`, that file across renames                   |
| `GET /api/vaults/:vault/history/:commit/diff?path=`          | unified diff of one commit, optionally one file                                |
| `GET /api/vaults/:vault/history/:commit/file?path=`          | the file as it was in that commit                                              |
| `POST /api/vaults/:vault/restore` `{path, commit, from?}`    | write an old version back as a new change (`from`: its old path, if renamed)   |
| `GET /api/vaults/:vault/checkpoints`                         | tags                                                                           |
| `POST /api/vaults/:vault/checkpoints` `{message, tag?}`      | commit everything now and optionally tag it; a bad or used tag changes nothing |
| `GET /api/vaults/:vault/backup`                              | backup settings and the outcome of the last push                               |
| `PUT /api/vaults/:vault/backup` `{remote, intervalMinutes?}` | turn backup on (or `remote: null` for off), then push once                     |
| `POST /api/vaults/:vault/backup/push`                        | push now                                                                       |

## Off-site backup

The remote and the interval (default 10 minutes) live in the vault's `.palimvo/config.json`
under `backup`. Because that file is versioned and pushed, the address may not contain a user
name, password or token. Only `https://`, `ssh://` and `git@host:path` addresses are accepted.

- **https**: set `PALIMVO_BACKUP_TOKEN` (and optionally `PALIMVO_BACKUP_USERNAME`, default
  `x-access-token`) on the server. It is passed to git through `GIT_CONFIG_*` environment
  variables, never on a command line or in a file.
- **ssh**: git uses the keys of the user running the server.

All branches and tags are pushed; nothing is ever forced. A failed push shows up in the status
(with credentials masked) and the next interval tries again. Storing credentials per vault in the
encrypted server database is a later step (it needs the SQLite store from T09).
