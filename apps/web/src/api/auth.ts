import { request, setCsrfToken, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;

export interface Account {
  id: string;
  username: string;
  displayName: string;
  serverAdmin: boolean;
  disabled: boolean;
  createdAt: number;
}

/** What `GET /api/auth/me` says about the caller. */
export type Me =
  | { state: "setup" }
  | { state: "open" }
  | { state: "guest" }
  | { state: "account"; account: Account; csrfToken: string };

interface SignedIn {
  account: Account;
  csrfToken: string;
}

export function getMe(options: Signal = {}): Promise<Me> {
  return request<Me>("/api/auth/me", options);
}

export interface MyPermissions {
  server: string[];
  vault?: string[];
}

export function getMyPermissions(vault?: string, options: Signal = {}): Promise<MyPermissions> {
  const query = vault ? `?vault=${encodeURIComponent(vault)}` : "";
  return request<MyPermissions>(`/api/me/permissions${query}`, options);
}

/** Keeps the token the server returns so later writes carry it. */
async function signedIn<T extends SignedIn>(call: Promise<T>): Promise<T> {
  const result = await call;
  setCsrfToken(result.csrfToken);
  return result;
}

export function login(username: string, password: string): Promise<SignedIn> {
  return signedIn(
    request<SignedIn>("/api/auth/login", { method: "POST", body: { username, password } }),
  );
}

export async function logout(): Promise<void> {
  await request<void>("/api/auth/logout", { method: "POST" });
  setCsrfToken(null);
}

export function changePassword(current: string, next: string): Promise<void> {
  return request<void>("/api/auth/password", { method: "POST", body: { current, next } });
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent?: string;
}

export async function listSessions(options: Signal = {}): Promise<SessionInfo[]> {
  return (await request<{ sessions: SessionInfo[] }>("/api/auth/sessions", options)).sessions;
}

export function revokeSession(id: string): Promise<void> {
  return request<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface InvitePreview {
  note?: string;
  expiresAt: number;
  vaults: { vaultId: string; position: "admin" | "member" }[];
  roles: { id: string; name: string; color?: string }[];
}

export function previewInvite(token: string, options: Signal = {}): Promise<InvitePreview> {
  return request<InvitePreview>(`/api/auth/invites/${encodeURIComponent(token)}`, options);
}

export function acceptInvite(
  token: string,
  body: { username: string; password: string; displayName?: string },
): Promise<SignedIn> {
  return signedIn(
    request<SignedIn>(`/api/auth/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      body,
    }),
  );
}

export interface SetupStatus {
  required: boolean;
  needsCode: boolean;
}

export function getSetupStatus(options: Signal = {}): Promise<SetupStatus> {
  return request<SetupStatus>("/api/setup/status", options);
}

export interface SetupInput {
  code?: string;
  username: string;
  password: string;
  displayName?: string;
  vault: { id: string; sample: boolean };
}

export function runSetup(input: SetupInput): Promise<SignedIn & { vault: unknown }> {
  return signedIn(request("/api/setup", { method: "POST", body: input }));
}
