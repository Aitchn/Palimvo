import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.ts";

export const LOCK_FILE = "server.lock";

const GUARD_STALE_MS = 10_000;

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
  held.add(file); // claimed before any await, so concurrent callers in this process lose
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await tryCreate(file, info)) return { release: () => release(file) };
      const owner = await readOwner(file);
      if (owner && isRunning(owner.pid)) throw alreadyRunning(owner, dataDir);
      await takeOver(file, owner);
    }
  } catch (err) {
    held.delete(file);
    throw err;
  }
  held.delete(file);
  throw new AppError(
    "lock_failed",
    500,
    `Could not take the lock ${file}; remove it if no server is running.`,
  );
}

/**
 * Creates the lock with its content already complete: the file is written under a private name and
 * hard-linked into place, which fails if the lock exists. A reader therefore never sees a half-written lock.
 */
async function tryCreate(file: string, info: LockInfo): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(info), { flag: "wx" });
  try {
    await link(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Removes a stale lock. Contenders take a guard first and re-check the lock under it, so a lock
 * freshly created by another server is never deleted by mistake.
 */
async function takeOver(file: string, inspected: LockInfo | undefined): Promise<void> {
  const guard = `${file}.takeover`;
  try {
    await writeFile(guard, String(process.pid), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Someone else is taking over; if they died mid-way their guard goes stale.
    const age = await stat(guard).then(
      (s) => Date.now() - s.mtimeMs,
      () => 0,
    );
    if (age > GUARD_STALE_MS) await rm(guard, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    return;
  }
  try {
    const current = await readOwner(file);
    const unchanged =
      current?.pid === inspected?.pid && current?.startedAt === inspected?.startedAt;
    if (unchanged && !(current && isRunning(current.pid))) await rm(file, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
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
