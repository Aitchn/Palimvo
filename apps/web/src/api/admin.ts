import type { Account } from "./auth.ts";
import { request, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;
const id = encodeURIComponent;

export interface RoleRef {
  id: string;
  name: string;
}

export interface UserRow extends Account {
  roles: RoleRef[];
  vaults: { vaultId: string; position: "admin" | "member" }[];
}

export async function listUsers(options: Signal = {}): Promise<UserRow[]> {
  return (await request<{ users: UserRow[] }>("/api/admin/users", options)).users;
}

export function createUser(body: {
  username: string;
  password: string;
  displayName?: string;
}): Promise<UserRow> {
  return request<UserRow>("/api/admin/users", { method: "POST", body });
}

export function updateUser(
  userId: string,
  patch: { displayName?: string; disabled?: boolean; serverAdmin?: boolean },
): Promise<UserRow> {
  return request<UserRow>(`/api/admin/users/${id(userId)}`, { method: "PATCH", body: patch });
}

/** Without a password the server makes a temporary one and returns it. */
export async function resetPassword(userId: string, password?: string): Promise<string | null> {
  const result = await request<{ password?: string }>(`/api/admin/users/${id(userId)}/password`, {
    method: "POST",
    body: password === undefined ? {} : { password },
  });
  return result.password ?? null;
}

export function deleteUser(userId: string): Promise<void> {
  return request<void>(`/api/admin/users/${id(userId)}`, { method: "DELETE" });
}

export interface RoleRow extends RoleRef {
  color?: string;
  position: number;
  /** Server-level permissions the role grants. */
  permissions: string[];
  /** Vault permissions denied in every vault a holder joins. */
  joinDeny: string[];
  everyone: boolean;
  manageable: boolean;
  memberCount?: number;
}

export interface RoleInput {
  name: string;
  color?: string;
  position?: number;
  permissions?: string[];
  joinDeny?: string[];
}

export function createRole(body: RoleInput): Promise<RoleRow> {
  return request<RoleRow>("/api/admin/roles", { method: "POST", body });
}

export function updateRole(
  roleId: string,
  patch: Partial<Omit<RoleInput, "color">> & { color?: string | null },
): Promise<RoleRow> {
  return request<RoleRow>(`/api/admin/roles/${id(roleId)}`, { method: "PATCH", body: patch });
}

export function deleteRole(roleId: string): Promise<void> {
  return request<void>(`/api/admin/roles/${id(roleId)}`, { method: "DELETE" });
}

export interface PersonRef {
  id: string;
  username: string;
  displayName: string;
}

export async function listRoleMembers(roleId: string, options: Signal = {}): Promise<PersonRef[]> {
  return (
    await request<{ members: PersonRef[] }>(`/api/admin/roles/${id(roleId)}/members`, options)
  ).members;
}

export async function listRoles(options: Signal = {}): Promise<RoleRow[]> {
  return (await request<{ roles: RoleRow[] }>("/api/admin/roles", options)).roles;
}

export function assignRole(userId: string, roleId: string): Promise<void> {
  return request<void>(`/api/admin/users/${id(userId)}/roles/${id(roleId)}`, { method: "PUT" });
}

export function unassignRole(userId: string, roleId: string): Promise<void> {
  return request<void>(`/api/admin/users/${id(userId)}/roles/${id(roleId)}`, {
    method: "DELETE",
  });
}

export interface InviteRow {
  id: string;
  note?: string;
  expiresAt: number;
  expired: boolean;
  usedAt?: number;
  roleIds: string[];
  vaults: { vaultId: string; position: "admin" | "member" }[];
}

export async function listInvites(options: Signal = {}): Promise<InviteRow[]> {
  return (await request<{ invites: InviteRow[] }>("/api/admin/invites", options)).invites;
}

export function createInvite(body: {
  note?: string;
  roleIds?: string[];
  vaults?: { vaultId: string; position: "admin" | "member" }[];
  expiresInHours?: number;
}): Promise<{ url: string }> {
  return request<{ url: string }>("/api/admin/invites", { method: "POST", body });
}

export function revokeInvite(inviteId: string): Promise<void> {
  return request<void>(`/api/admin/invites/${id(inviteId)}`, { method: "DELETE" });
}

export interface RoleLabel extends RoleRef {
  color?: string;
  position: number;
}

export interface MemberRow {
  account: Account;
  position: "admin" | "member";
  addedAt: number;
  roles: RoleLabel[];
}

export async function listMembers(vault: string, options: Signal = {}): Promise<MemberRow[]> {
  return (await request<{ members: MemberRow[] }>(`/api/vaults/${id(vault)}/members`, options))
    .members;
}

export function setMember(
  vault: string,
  accountId: string,
  position: "admin" | "member",
): Promise<MemberRow> {
  return request<MemberRow>(`/api/vaults/${id(vault)}/members/${id(accountId)}`, {
    method: "PUT",
    body: { position },
  });
}

export function removeMember(vault: string, accountId: string): Promise<void> {
  return request<void>(`/api/vaults/${id(vault)}/members/${id(accountId)}`, { method: "DELETE" });
}

export async function getPublicPaths(vault: string, options: Signal = {}): Promise<string[]> {
  return (await request<{ paths: string[] }>(`/api/vaults/${id(vault)}/public`, options)).paths;
}

export async function setPublicPaths(vault: string, paths: string[]): Promise<string[]> {
  return (
    await request<{ paths: string[] }>(`/api/vaults/${id(vault)}/public`, {
      method: "PUT",
      body: { paths },
    })
  ).paths;
}

/** The two kinds of people and groups a permission override can be about. */
export type Subject = { type: "role" | "account"; id: string };

export interface OverrideRow {
  /** Absent for a vault-wide override. */
  folder?: string;
  subjectType: Subject["type"];
  subjectId: string;
  allow: string[];
  deny: string[];
}

export interface VaultPermissions {
  roles: RoleLabel[];
  /** The people the overrides are about. */
  people: PersonRef[];
  overrides: OverrideRow[];
}

export function getVaultPermissions(
  vault: string,
  options: Signal = {},
): Promise<VaultPermissions> {
  return request<VaultPermissions>(`/api/vaults/${id(vault)}/permissions`, options);
}

/** Sets what `subject` is allowed and denied; with both lists empty the override is removed. */
export function setOverride(
  vault: string,
  body: { folder?: string; subject: Subject; allow: string[]; deny: string[] },
): Promise<VaultPermissions> {
  return request<VaultPermissions>(`/api/vaults/${id(vault)}/permissions`, {
    method: "PUT",
    body: {
      ...(body.folder === undefined ? {} : { folder: body.folder }),
      subjectType: body.subject.type,
      subjectId: body.subject.id,
      allow: body.allow,
      deny: body.deny,
    },
  });
}

/** What the subject can do in the vault, or in `folder` of it. */
export async function previewPermissions(
  vault: string,
  subject: Subject,
  options: Signal & { folder?: string } = {},
): Promise<string[]> {
  const query = new URLSearchParams({
    [subject.type === "role" ? "roleId" : "accountId"]: subject.id,
  });
  if (options.folder) query.set("folder", options.folder);
  return (
    await request<{ permissions: string[] }>(
      `/api/vaults/${id(vault)}/permissions/preview?${query}`,
      { signal: options.signal },
    )
  ).permissions;
}

export interface PersonHit extends PersonRef {
  member: boolean;
}

/** Finds people by name for adding to the vault or giving a personal override. */
export async function searchPeople(
  vault: string,
  query: string,
  options: Signal = {},
): Promise<PersonHit[]> {
  return (
    await request<{ people: PersonHit[] }>(
      `/api/vaults/${id(vault)}/people?q=${encodeURIComponent(query)}`,
      options,
    )
  ).people;
}

export interface RosterEntry {
  /** The id the person's changes carry as author. */
  authorId: string;
  name: string;
  position: "admin" | "member";
  roles: RoleLabel[];
}

export async function getRoster(vault: string, options: Signal = {}): Promise<RosterEntry[]> {
  return (await request<{ people: RosterEntry[] }>(`/api/vaults/${id(vault)}/roster`, options))
    .people;
}
