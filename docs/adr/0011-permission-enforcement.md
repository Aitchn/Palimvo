# 0011. Enforcing roles and permissions on the server

- Status: accepted
- Date: 2026-10-22

## Context

T51 computes permissions as a pure function. T52 has to use it on every route, add the APIs to
manage roles, vault members and overrides, and replace the interim rules of ADR 0010.

## Decision

- **One check per request.** `AccessControl` (owned by `AuthService`) builds a `RequestAccess` for
  each request. It loads the roles, the server overrides and, per vault, that vault's overrides and
  public flag at most once, then answers with `resolvePermissions`. Any change to roles, members or
  overrides calls `access.invalidate()`, which also drops what requests still running had cached.
- **Routes ask for a permission, not a position.** `accessOf(c).requireVault("note.write", vault)`,
  `requireServer("users.manage")`, and `requireTree(...)` for paths. A vault the caller cannot view
  answers `vault_not_found` (existence is not leaked); a missing permission answers `forbidden`;
  guests are told to sign in.
- **Folder rules** apply to the folder that holds the file. Deleting, moving or creating something
  also checks the thing itself and every folder with its own override inside it, so acting on a
  parent cannot get around a rule further down. A move needs `note.delete` at the source and
  `note.write` at the destination. A batch is checked completely before anything is written.
  Paths are normalized before the check and folder names compare case-insensitively.
- **Route to permission map.** Reading (files, search, links, graph, ZIP): `note.read`. Writing,
  creating folders, checkpoints: `note.write`. Delete: `note.delete`. History and checkpoint lists:
  `history.view`; restore: `history.restore` plus `note.write` on the file. Backup settings:
  `vault.settings`. Members, permissions, public set: `members.manage`, `permissions.manage`,
  `public.manage`. Creating a vault: `vaults.create` (the creator becomes its administrator and a
  recreated id starts with no leftovers); removing and restoring vaults: `server.manage`; users and
  invites: `users.manage`; roles and server grants: `roles.manage`.
- **No escalation.** Roles can only be created or edited below the caller's highest role and can
  only gain permissions the caller holds (`canManageRole`, `canSetRolePermissions`). Overrides can
  only allow what the caller holds in that scope. Only a vault administrator or a server
  administrator can make, demote or remove a vault administrator. People with `users.manage` cannot
  change, reset, disable or delete a server administrator, or make one. Invites can only carry
  roles the inviter may manage and vaults where they hold `members.manage`.
- **Role join defaults (Reader).** A role has `join_deny`: vault bits denied wherever its holder
  is a member. The first time a role meets a vault (the holder joins it, or the role is given to an
  existing member) the bits are copied into a vault override for that role. Later edits by a vault
  administrator are kept. Use `Store.joinVault` and `Store.grantRole`, never the repository calls.
- **Audit.** Role, assignment, member and override changes write `role.*`, `vault.member_*` and
  `vault.permission_*` / `permission.server_*` entries.

## Consequences

- Plain accounts no longer see every vault: they list and open the vaults they joined.
- Deleting a vault stays with `server.manage`; a vault administrator cannot remove their vault yet.
- Permissions with no API yet (`file.upload`, `proposal.*`, `mcp.connect`, `plugin.*`,
  `assistant.*`, `library.publish`, `audit.view`) are enforced when those routes arrive.
- Tokens, the assistant and plugins narrow the result with `intersect` (T12 and later).
