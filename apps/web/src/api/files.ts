import type { FileContent, TreeNode } from "@palimvo/core";
import { encodePath, request, type RequestOptions } from "./client.ts";

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
