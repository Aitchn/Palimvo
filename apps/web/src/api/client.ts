import { ApiError, errorFromResponse } from "./errors.ts";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
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

/**
 * The one place that talks to the server. Every domain module (`vaults.ts`, `files.ts`, …) calls
 * this, so errors always arrive as {@link ApiError} with a code the interface can translate.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(path, {
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
  if (!response.ok) throw await errorFromResponse(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
