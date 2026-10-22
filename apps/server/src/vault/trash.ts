import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { AppError, isValidVaultId, type RemovedVault } from "@palimvo/core";
import { exists } from "./fsutil.ts";
import type { VaultService } from "./service.ts";

/** `<vault-id>-<UTC timestamp>`, with `-2`, `-3`… if two removals share a second. */
const TRASH_NAME = /^(.+)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-\d+)?$/;

/**
 * Removing a vault moves its whole folder (files, history, settings) to `trash/vaults/`, where
 * the app no longer serves it. It can be put back under its old id until someone deletes the
 * trash folder by hand.
 */
export class VaultTrash {
  constructor(
    private readonly vaults: VaultService,
    /** `<data dir>/trash/vaults` */
    readonly dir: string,
  ) {}

  async remove(id: string, now: Date = new Date()): Promise<RemovedVault> {
    if (!(await this.vaults.listVaults()).some((v) => v.id === id)) {
      throw new AppError("vault_not_found", undefined, { vault: id });
    }
    // File names carry whole seconds, so the reported time does too.
    now = new Date(Math.floor(now.getTime() / 1000) * 1000);
    if (!this.vaults.beginRemoval(id))
      throw new AppError("vault_not_found", undefined, { vault: id });
    try {
      const stamp = now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z");
      const name = await this.freeName(`${id}-${stamp}`);
      await mkdir(this.dir, { recursive: true });
      await this.vaults.archiveVault(id, path.join(this.dir, name));
      return { name, id, removedAt: now.toISOString() };
    } catch (err) {
      this.vaults.cancelRemoval(id);
      throw err;
    }
  }

  async list(): Promise<RemovedVault[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const removed: RemovedVault[] = [];
    for (const entry of entries) {
      const parsed = entry.isDirectory() ? parseTrashName(entry.name) : null;
      if (parsed) removed.push({ name: entry.name, ...parsed });
    }
    return removed.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
  }

  /** Puts a removed vault back under its old id. */
  async restore(name: string): Promise<{ id: string }> {
    const parsed = parseTrashName(name);
    if (!parsed || !(await exists(path.join(this.dir, name)))) {
      throw new AppError("not_found", undefined, { removed: name });
    }
    await this.vaults.restoreVault(path.join(this.dir, name), parsed.id);
    return { id: parsed.id };
  }

  private async freeName(base: string): Promise<string> {
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (!(await exists(path.join(this.dir, name)))) return name;
    }
  }
}

function parseTrashName(name: string): { id: string; removedAt: string } | null {
  const m = TRASH_NAME.exec(name);
  if (!m || !isValidVaultId(m[1]!)) return null;
  const [, id, y, mo, d, h, mi, s] = m;
  return { id: id!, removedAt: `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z` };
}
