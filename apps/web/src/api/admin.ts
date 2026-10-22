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
  everyone: boolean;
  manageable: boolean;
  memberCount?: number;
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

export interface MemberRow {
  account: Account;
  position: "admin" | "member";
  addedAt: number;
  roles: RoleRef[];
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
