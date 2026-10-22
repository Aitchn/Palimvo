import type { Migration } from "./db.ts";

/**
 * Schema history, oldest first. Never edit a released migration; add a new one. Timestamps are
 * integer milliseconds since the Unix epoch. Secrets (passwords, session ids, token values) are
 * stored only as hashes made by the caller.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
create table accounts (
  id text primary key,
  username text not null unique collate nocase,
  display_name text not null,
  password_hash text not null,
  server_admin integer not null default 0 check (server_admin in (0, 1)),
  disabled integer not null default 0 check (disabled in (0, 1)),
  created_at integer not null,
  updated_at integer not null
) strict;

-- Position inside one vault: the built-in vault administrator or an ordinary member.
create table vault_members (
  vault_id text not null,
  account_id text not null references accounts (id) on delete cascade,
  position text not null check (position in ('admin', 'member')),
  added_at integer not null,
  primary key (vault_id, account_id)
) strict;
create index vault_members_account on vault_members (account_id);

create table sessions (
  id text primary key, -- hash of the cookie value
  account_id text not null references accounts (id) on delete cascade,
  created_at integer not null,
  last_seen_at integer not null,
  expires_at integer not null,
  user_agent text
) strict;
create index sessions_account on sessions (account_id);
create index sessions_expires on sessions (expires_at);

create table roles (
  id text primary key,
  name text not null unique collate nocase,
  color text,
  position integer not null, -- higher outranks lower
  permissions integer not null default 0, -- server-level permission bits
  is_everyone integer not null default 0 check (is_everyone in (0, 1)),
  created_at integer not null
) strict;
create unique index roles_everyone on roles (is_everyone) where is_everyone = 1;

create table role_members (
  role_id text not null references roles (id) on delete cascade,
  account_id text not null references accounts (id) on delete cascade,
  assigned_at integer not null,
  primary key (role_id, account_id)
) strict;
create index role_members_account on role_members (account_id);

-- Allow/deny bits for a role or a person at server, vault or folder scope.
create table permission_overrides (
  id integer primary key autoincrement,
  scope text not null check (scope in ('server', 'vault', 'folder')),
  vault_id text,
  folder text,
  subject_type text not null check (subject_type in ('role', 'account')),
  subject_id text not null,
  allow integer not null default 0,
  deny integer not null default 0,
  updated_at integer not null,
  check (
    (scope = 'server' and vault_id is null and folder is null) or
    (scope = 'vault' and vault_id is not null and folder is null) or
    (scope = 'folder' and vault_id is not null and folder is not null)
  )
) strict;
create unique index permission_overrides_key on permission_overrides
  (scope, ifnull(vault_id, ''), ifnull(folder, ''), subject_type, subject_id);
create index permission_overrides_vault on permission_overrides (vault_id);
create index permission_overrides_subject on permission_overrides (subject_type, subject_id);

-- The subject column is polymorphic, so cleanup on delete is done with triggers.
create trigger roles_delete_overrides after delete on roles begin
  delete from permission_overrides where subject_type = 'role' and subject_id = old.id;
end;
create trigger accounts_delete_overrides after delete on accounts begin
  delete from permission_overrides where subject_type = 'account' and subject_id = old.id;
end;

create table api_tokens (
  id text primary key,
  account_id text not null references accounts (id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  access text not null check (access in ('read', 'write', 'propose')),
  vault_id text, -- null means every vault the creator can reach
  folders text not null default '[]', -- JSON array; empty means the whole vault
  rate_limit_per_minute integer,
  created_at integer not null,
  expires_at integer,
  last_used_at integer,
  revoked_at integer
) strict;
create index api_tokens_account on api_tokens (account_id);

create table oauth_clients (
  client_id text primary key,
  client_name text not null,
  redirect_uris text not null, -- JSON array
  secret_hash text,
  created_at integer not null
) strict;

create table oauth_grants (
  id text primary key,
  client_id text not null references oauth_clients (client_id) on delete cascade,
  account_id text not null references accounts (id) on delete cascade,
  scope text not null default '',
  created_at integer not null,
  revoked_at integer
) strict;
create index oauth_grants_account on oauth_grants (account_id);
create index oauth_grants_client on oauth_grants (client_id);

-- Authorization codes, access tokens and refresh tokens.
create table oauth_tokens (
  id text primary key,
  grant_id text not null references oauth_grants (id) on delete cascade,
  kind text not null check (kind in ('code', 'access', 'refresh')),
  token_hash text not null unique,
  expires_at integer not null,
  code_challenge text,
  redirect_uri text,
  used_at integer,
  revoked_at integer,
  created_at integer not null
) strict;
create index oauth_tokens_grant on oauth_tokens (grant_id);
create index oauth_tokens_expires on oauth_tokens (expires_at);

create table audit_log (
  id integer primary key autoincrement,
  at integer not null,
  actor_type text not null check (actor_type in ('account', 'token', 'assistant', 'plugin', 'system')),
  actor_id text,
  actor_label text,
  action text not null,
  target_type text,
  target_id text,
  vault_id text,
  detail text, -- JSON
  ip text
) strict;
create index audit_log_at on audit_log (at);
create index audit_log_action on audit_log (action, at);
create index audit_log_vault on audit_log (vault_id, at);
create index audit_log_actor on audit_log (actor_id, at);
create trigger audit_log_immutable before update on audit_log begin
  select raise(abort, 'audit_log rows cannot be changed');
end;

create table server_settings (
  key text primary key,
  value text not null, -- JSON
  updated_at integer not null
) strict;

create table library_plugins (
  id text not null,
  version text not null,
  name text not null,
  manifest text not null, -- JSON
  sha256 text not null,
  builtin integer not null default 0 check (builtin in (0, 1)),
  uploaded_by text references accounts (id) on delete set null,
  uploaded_at integer not null,
  primary key (id, version)
) strict;
`,
  },
  {
    version: 2,
    name: "invites and public access",
    sql: `
-- One-time sign-up links. The secret is shown once; only its hash is stored.
create table invites (
  id text primary key,
  token_hash text not null unique,
  created_by text references accounts (id) on delete set null,
  note text,
  roles text not null default '[]', -- JSON array of role ids granted on sign-up
  vaults text not null default '[]', -- JSON array of {vaultId, position}
  created_at integer not null,
  expires_at integer not null,
  used_at integer,
  used_by text references accounts (id) on delete set null
) strict;
create index invites_expires on invites (expires_at);

-- What guests (people who are not signed in) may read: a whole vault (path ''), a folder or a file.
create table public_access (
  vault_id text not null,
  path text not null,
  created_at integer not null,
  primary key (vault_id, path)
) strict;
`,
  },
  {
    version: 3,
    name: "role join defaults",
    sql: `
-- Vault-level permissions a role denies once its holder joins a vault (the Reader template).
-- The deny is copied into a vault override the first time the role meets that vault.
alter table roles add column join_deny integer not null default 0;
`,
  },
  {
    version: 4,
    name: "vault plugins",
    sql: `
-- Plugins installed in a vault. The files live in the vault's .palimvo/plugins/<id>/ folder;
-- this row says which package they are (by content hash) and whether the plugin is switched on.
create table vault_plugins (
  vault_id text not null,
  plugin_id text not null,
  version text not null,
  sha256 text not null,
  manifest text not null, -- JSON: the validated manifest of this package
  enabled integer not null default 0 check (enabled in (0, 1)),
  source text not null check (source in ('library', 'upload')),
  installed_by text references accounts (id) on delete set null,
  installed_at integer not null,
  primary key (vault_id, plugin_id)
) strict;

-- A person's approval of one exact package hash in one vault. Approvals stay with the server, not
-- the vault's files, so a vault copied to another server has to be approved again.
create table plugin_approvals (
  vault_id text not null,
  plugin_id text not null,
  sha256 text not null,
  version text not null,
  approved_by text references accounts (id) on delete set null,
  approved_at integer not null,
  permissions text not null, -- JSON: the permissions the person saw when approving
  primary key (vault_id, plugin_id, sha256)
) strict;
`,
  },
  {
    version: 5,
    name: "upload links",
    sql: `
-- A link that lets one file be uploaded without signing in. The secret is shown once; only its
-- hash is stored. The link is used up when the file is saved.
create table upload_links (
  token_hash text primary key,
  vault_id text not null,
  path text not null,
  create_only integer not null default 0 check (create_only in (0, 1)),
  author text not null, -- JSON: who the history credits
  reason text,
  created_at integer not null,
  expires_at integer not null,
  upload_id text -- the resumable upload this link started
) strict;
create index upload_links_vault on upload_links (vault_id);
create index upload_links_expires on upload_links (expires_at);
`,
  },
];
