import { ApiError, errorFromResponse } from "./errors.ts";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  /** Extra headers, e.g. `If-Match`. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Encodes a vault-relative path for a URL, keeping the slashes between names. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

let csrfToken: string | null = null;

/** The token the server issued with the session; sent on every request that changes something. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Headers a hand-made request needs besides the cookie: the CSRF token, when there is one. */
export function csrfHeaders(): Record<string, string> {
  return csrfToken ? { "X-Palimvo-Csrf": csrfToken } : {};
}

/** Reports a response the browser could not send through {@link request} (an upload with progress). */
export async function failure(response: Response): Promise<ApiError> {
  return failed(response);
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (csrfToken && (options.method ?? "GET") !== "GET") headers["X-Palimvo-Csrf"] = csrfToken;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError("network", 0, "The server could not be reached.");
  }
}

/** Raised on `window` when the server says the session is gone, so the app can show the sign-in. */
export const SESSION_LOST_EVENT = "palimvo:session-lost";

async function failed(response: Response): Promise<ApiError> {
  const error = await errorFromResponse(response);
  // A stale token (another tab signed in as someone else) is as good as a lost session.
  if (error.code === "unauthenticated" || error.code === "csrf_invalid")
    window.dispatchEvent(new Event(SESSION_LOST_EVENT));
  return error;
}

/**
 * The one place that talks to the server. Every domain module (`vaults.ts`, `files.ts`, …) calls
 * this, so errors always arrive as {@link ApiError} with a code the interface can translate.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  if (!response.ok) throw await failed(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * A GET that sends `If-None-Match`. Resolves to `null` when the server answers 304 (nothing
 * changed), else the body and its new `ETag`.
 */
export async function requestIfChanged<T>(
  path: string,
  etag: string | null,
  options: Pick<RequestOptions, "signal"> = {},
): Promise<{ data: T; etag: string | null } | null> {
  const response = await send(path, {
    ...options,
    headers: etag ? { "If-None-Match": etag } : undefined,
  });
  if (response.status === 304) return null;
  if (!response.ok) throw await failed(response);
  return { data: (await response.json()) as T, etag: response.headers.get("ETag") };
}
