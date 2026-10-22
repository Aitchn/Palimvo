import type { RemovedVault, VaultInfo } from "@palimvo/core";
import { request, type RequestOptions } from "./client.ts";

type Signal = Pick<RequestOptions, "signal">;

export async function listVaults(options: Signal = {}): Promise<VaultInfo[]> {
  return (await request<{ vaults: VaultInfo[] }>("/api/vaults", options)).vaults;
}

export function createVault(id: string): Promise<VaultInfo> {
  return request<VaultInfo>("/api/vaults", { method: "POST", body: { id } });
}

export function removeVault(id: string): Promise<RemovedVault> {
  return request<RemovedVault>(`/api/vaults/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listRemovedVaults(options: Signal = {}): Promise<RemovedVault[]> {
  return (await request<{ removed: RemovedVault[] }>("/api/removed-vaults", options)).removed;
}

export function restoreVault(name: string): Promise<VaultInfo> {
  return request<VaultInfo>(`/api/removed-vaults/${encodeURIComponent(name)}/restore`, {
    method: "POST",
  });
}
