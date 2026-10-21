import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.ts";

export const LOCK_FILE = "server.lock";

interface LockInfo {
  pid: number;
  startedAt: string;
}

/** Locks held by this process; its own pid in a lock file is otherwise indistinguishable from a stale one. */
const held = new Set<string>();

export interface InstanceLock {
  release(): Promise<void>;
}

/**
 * Only one server may own a data directory: two writers would corrupt the database and vaults.
 * The lock is a file created exclusively and holding the owner's pid. A lock whose pid no longer
 * runs (crash, `kill -9`) is stale and taken over.
 */
export async function acquireLock(dataDir: string): Promise<InstanceLock> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK_FILE);
  if (held.has(file))
    throw alreadyRunning({ pid: process.pid, startedAt: "this process" }, dataDir);
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify(info));
      await handle.close();
      held.add(file);
      return { release: () => release(file) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const owner = await readOwner(file);
    if (owner && isRunning(owner.pid)) {
      throw alreadyRunning(owner, dataDir);
    }
    await rm(file, { force: true });
  }
  throw new AppError(
    "lock_failed",
    500,
    `Could not take the lock ${file}; remove it if no server is running.`,
  );
}

function alreadyRunning(owner: LockInfo, dataDir: string): AppError {
  return new AppError(
    "already_running",
    500,
    `Another Palimvo server (pid ${owner.pid}, started ${owner.startedAt}) is using ${dataDir}. ` +
      `Stop it first, or choose another data directory with --data-dir.`,
    { pid: owner.pid, dataDir },
  );
}

async function release(file: string): Promise<void> {
  held.delete(file);
  // Never remove a lock someone else took over.
  const owner = await readOwner(file);
  if (owner?.pid === process.pid) await rm(file, { force: true });
}

async function readOwner(file: string): Promise<LockInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && "pid" in parsed && typeof parsed.pid === "number") {
      const startedAt =
        "startedAt" in parsed && typeof parsed.startedAt === "string"
          ? parsed.startedAt
          : "unknown";
      return { pid: parsed.pid, startedAt };
    }
  } catch {
    // unreadable or half-written: treated as stale below
  }
  return undefined;
}

function isRunning(pid: number): boolean {
  // After a container restart the new process often gets the same pid (1) as the one that crashed.
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
