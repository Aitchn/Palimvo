import type { SearchHit } from "@palimvo/core";
import type { VaultSearchHit } from "@palimvo/plugin-sdk";
import { ApiError } from "../api/errors.ts";
import { encodePath, request } from "../api/client.ts";
import { fileTree, readFile } from "../api/files.ts";
import { graphOf, searchVault } from "../api/search.ts";
import { RpcError, type RpcErrorCode } from "./protocol.ts";
import type { VaultBackend } from "./bridge.ts";

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}`;

function codeFor(error: ApiError): RpcErrorCode {
  switch (error.code) {
    case "not_found":
    case "vault_not_found":
      return "not_found";
    case "forbidden":
    case "token_scope_denied":
    case "propose_only":
    case "plugin_not_approved":
    case "unauthenticated":
      return "permission_denied";
    case "version_conflict":
    case "proposal_stale":
      return "version_conflict";
    case "payload_too_large":
    case "rate_limited":
      return "quota_exceeded";
    case "invalid_request":
    case "invalid_path":
    case "unsupported_type":
      return "invalid_argument";
    default:
      return "unavailable";
  }
}

/** Server errors keep their meaning for the plugin, but not their details. */
async function translated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw new RpcError(codeFor(error), error.message);
    throw error;
  }
}

function toHit(hit: SearchHit): VaultSearchHit {
  const title =
    hit.path
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? hit.path;
  const snippet = hit.matches
    .map((match) => match.text)
    .join(" ")
    .slice(0, 300);
  return { path: hit.path, title, ...(snippet ? { snippet } : {}) };
}

/**
 * The vault as the signed-in person sees it. Plugin calls ride on the person's own session, so
 * the server's role and folder checks apply on top of the folders the plugin declared.
 */
export function apiBackend(vault: string, pluginId: string): VaultBackend {
  // The history credits the person; the reason says which plugin acted (a plugin author kind is T32).
  const reasonHeader = (reason: string | undefined) => ({
    "X-Palimvo-Reason": encodeURIComponent(
      `Plugin ${pluginId}${reason ? `: ${reason}` : ""}`.slice(0, 300),
    ),
  });
  return {
    read: (path, signal) =>
      translated(async () => (await readFile(vault, path, { signal })).content),
    async readBinary(path, signal) {
      return translated(async () => {
        let response: Response;
        try {
          response = await fetch(`${base(vault)}/raw/${encodePath(path)}`, {
            credentials: "same-origin",
            signal,
          });
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
          throw new RpcError("unavailable", "The server could not be reached");
        }
        if (response.status === 404) throw new RpcError("not_found", "File not found");
        if (response.status === 403) throw new RpcError("permission_denied", "Not allowed");
        if (!response.ok) throw new RpcError("unavailable", "The file could not be read");
        return new Uint8Array(await response.arrayBuffer());
      });
    },
    tree: (signal) => translated(() => fileTree(vault, { signal })),
    async search(query, options, signal) {
      const page = await translated(() =>
        searchVault(vault, query, { limit: options.limit, folder: options.folder, signal }),
      );
      return page.hits.map(toHit);
    },
    queryBase() {
      // The database engine and its endpoint arrive with T21.
      return Promise.reject(new RpcError("unavailable", "Database queries are not available yet"));
    },
    async graph(options, signal) {
      const { nodes, edges } = await translated(() => graphOf(vault, { ...options, signal }));
      return {
        nodes: nodes.flatMap(({ kind, ...node }) =>
          kind === "markdown" || kind === "canvas" || kind === "base" ? [{ ...node, kind }] : [],
        ),
        edges,
      };
    },
    async write(path, content, reason, signal) {
      const result = await translated(() =>
        request<{ version: string }>(`${base(vault)}/files/${encodePath(path)}`, {
          method: "PUT",
          body: { content },
          headers: reasonHeader(reason),
          signal,
        }),
      );
      return { revision: result.version };
    },
    async propose(input, signal) {
      // One hunk that replaces the whole text: a reviewer sees the file's before and after.
      const current = await translated(() => readFile(vault, input.path, { signal })).catch(
        (error: unknown) => {
          if (error instanceof RpcError && error.code === "not_found") return null;
          throw error;
        },
      );
      const created = await translated(() =>
        request<{ id: string }>(`${base(vault)}/proposals`, {
          method: "POST",
          signal,
          headers: reasonHeader(input.reason),
          body: {
            title: input.title ?? `Change to ${input.path}`,
            rationale: input.reason ?? "",
            files: [
              {
                path: input.path,
                baseRevision: current ? current.version : null,
                hunks: [
                  {
                    start: 0,
                    end: current ? current.content.length : 0,
                    before: current ? current.content : "",
                    after: input.content,
                    rationale: input.reason ?? "",
                  },
                ],
              },
            ],
          },
        }),
      );
      return { proposalId: created.id };
    },
  };
}
