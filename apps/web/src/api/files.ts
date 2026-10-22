import type { FileContent, TreeNode } from "@palimvo/core";
import { encodePath, request, requestIfChanged, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;

const base = (vault: string) => `/api/vaults/${encodeURIComponent(vault)}`;

export interface WriteResult {
  path: string;
  version: string;
  mtime: number;
}

export async function fileTree(vault: string, options: Signal = {}): Promise<TreeNode[]> {
  return (await request<{ tree: TreeNode[] }>(`${base(vault)}/files`, options)).tree;
}

/**
 * The tree again, but only if it changed since `etag` was returned (then `null`). Polling this
 * costs the server a hash comparison, not a tree walk.
 */
export async function fileTreeIfChanged(
  vault: string,
  etag: string | null,
  options: Signal = {},
): Promise<{ tree: TreeNode[]; etag: string | null } | null> {
  const result = await requestIfChanged<{ tree: TreeNode[] }>(
    `${base(vault)}/files`,
    etag,
    options,
  );
  return result && { tree: result.data.tree, etag: result.etag };
}

/** Address of the ZIP of a folder (`""`: the whole vault). The browser downloads it directly. */
export function archiveUrl(vault: string, folder: string): string {
  return `${base(vault)}/archive${folder ? `?path=${encodeURIComponent(folder)}` : ""}`;
}

export function readFile(vault: string, path: string, options: Signal = {}): Promise<FileContent> {
  return request<FileContent>(`${base(vault)}/files/${encodePath(path)}`, options);
}

/** Pass the `version` you read as `baseVersion` to fail with `version_conflict` instead of overwriting. */
export function writeFile(
  vault: string,
  path: string,
  content: string,
  baseVersion?: string | null,
): Promise<WriteResult> {
  return request<WriteResult>(`${base(vault)}/files/${encodePath(path)}`, {
    method: "PUT",
    body: baseVersion === undefined ? { content } : { content, baseVersion },
  });
}

export function deleteFile(vault: string, path: string): Promise<void> {
  return request<void>(`${base(vault)}/files/${encodePath(path)}`, { method: "DELETE" });
}

export function createFolder(vault: string, path: string): Promise<unknown> {
  return request(`${base(vault)}/folders`, { method: "POST", body: { path } });
}

export function moveFile(vault: string, from: string, to: string): Promise<unknown> {
  return request(`${base(vault)}/move`, { method: "POST", body: { from, to } });
}
