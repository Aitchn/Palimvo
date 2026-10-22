# 0014. Role and permission screens

- Status: accepted
- Date: 2026-10-22

## Context

ADR 0011 enforces roles and permissions on every route, but only through the API. People need to
create roles, rank them, give them permissions and set per-vault and per-folder rules without
writing requests by hand. The plan's acceptance case is: a "Designer" role that may write only in
`design/`.

## Decision

- **Screens.** `/settings/roles` (server permission `roles.manage`): list ordered by rank with
  up/down buttons and drag-and-drop, name, colour, server permissions as switches, the vault
  permissions denied when someone joins a vault (the Reader mechanism of ADR 0011), and the role's
  people. A vault's settings page gets a "Permissions" section (`permissions.manage`): allow /
  inherit / deny per permission for each role or person, a list of folders that have their own
  rules, and "View as" which asks the server what a role (as an ordinary member) or a person ends
  up with. A folder's right-click menu opens the same editor for that folder, limited to the
  write-type permissions that folders can change.
- **Reordering** renumbers every role by tens for a server administrator. Anyone else only
  passes the rank values of roles they already manage around, and the move is refused when it
  would pass a role they do not manage, so nobody can end up above their own rank.
- **New read APIs.** `GET /api/admin/roles/:id/members`; `GET /api/vaults/:vault/people?q=`
  (find accounts by name; needs `members.manage` or `permissions.manage`, so a vault
  administrator without `users.manage` can add members and personal rules);
  `GET /api/vaults/:vault/permissions/preview?roleId|accountId[&folder]` (`permissions.manage`);
  `GET /api/vaults/:vault/roster` (`vault.view`: names and role labels of the vault's people for
  badges). The permissions listing also names the people its rules are about.
- **Role labels.** `RoleBadge` is the coloured chip; `AuthorBadge` shows a person's name with the
  chip of their highest ranked coloured role, looked up by author id in the roster; AIs and
  plugins get no chip. A cursor uses its role colour. History, proposals and the activity feed
  (T24 to T26) render `AuthorBadge`.
- **Folder rules can allow.** Folder rules layer on top of the vault's answer (ADR 0011 and plan
  section 12.3), so `requireTree` no longer asks the vault-wide question first. Before this change
  a vault-wide deny of `note.write` could not be lifted for one folder even though the permission
  calculation, the "what can I do here" API and the screens said it could. "Deny everywhere,
  allow in `design/`" now works; "allow everywhere, deny in `locked/`" works as before. Deleting or
  moving a parent still checks every folder with its own rule inside it.

## Consequences

- Reading is still decided for the whole vault; the folder editor offers write-type permissions
  only.
- The file tree decides which create / import buttons to show from the open file's folder, not
  from the folder you right-click. A role that can write only in `design/` sees them only while a
  file in `design/` is open. Fixing that needs a per-folder permission lookup in the tree.
- The server settings page and its API (T14's other leftover) are not part of this change.
