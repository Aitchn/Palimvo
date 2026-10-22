import { AppError, VAULT_META_DIR, type Author } from "@palimvo/core";
import { errorFields } from "../errors.ts";
import type { Logger } from "../log.ts";
import { parseVaultConfig, VAULT_CONFIG_FILE } from "../vault/meta.ts";
import type { VaultService } from "../vault/service.ts";
import { GitError } from "./git.ts";
import type { VaultHistory } from "./history.ts";

/** Where and how often a vault's history is pushed. Stored in the vault's `.palimvo/config.json`, so it holds no secrets. */
export interface BackupSettings {
  remote: string;
  intervalMinutes: number;
}

export interface BackupStatus {
  /** The remote URL, or null when backup is off. */
  remote: string | null;
  intervalMinutes: number | null;
  lastPushAt: string | null;
  lastError: string | null;
  /** True when the server has a token for https remotes (`PALIMVO_BACKUP_TOKEN`). */
  hasToken: boolean;
}

export interface BackupOptions {
  logger: Logger;
  /** How often to look for vaults that are due (default one minute). */
  tickMs?: number;
  /** Tests push to a local bare repository; production only allows network remotes. */
  allowLocalRemotes?: boolean;
  /**
   * Credentials for https remotes. Default: `PALIMVO_BACKUP_TOKEN` (and `PALIMVO_BACKUP_USERNAME`,
   * default `x-access-token`) from the environment. SSH remotes use the server user's own keys.
   */
  credentials?: { username: string; token: string } | null;
}

export const DEFAULT_BACKUP_INTERVAL_MINUTES = 10;
const REMOTE = "palimvo-backup";

/**
 * Pushes each vault's history to its configured remote (e.g. a private GitHub repo) as an
 * off-site copy.
 */
export class BackupService {
  private readonly status = new Map<
    string,
    { lastPushAt: string | null; lastError: string | null }
  >();
  private readonly lastAttempt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly log: Logger;
  private readonly tickMs: number;
  private readonly allowLocal: boolean;
  private readonly credentials: { username: string; token: string } | null;

  constructor(
    private readonly vaults: VaultService,
    private readonly history: VaultHistory,
    options: BackupOptions,
  ) {
    this.log = options.logger;
    this.tickMs = options.tickMs ?? 60_000;
    this.allowLocal = options.allowLocalRemotes ?? false;
    this.credentials =
      options.credentials === undefined ? credentialsFromEnv() : options.credentials;
  }

  start(): void {
    this.timer = setInterval(() => void this.pushDue(), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async get(vault: string): Promise<BackupStatus> {
    const settings = await this.settings(vault);
    const s = this.status.get(vault);
    return {
      remote: settings?.remote ?? null,
      intervalMinutes: settings?.intervalMinutes ?? null,
      lastPushAt: s?.lastPushAt ?? null,
      lastError: s?.lastError ?? null,
      hasToken: this.credentials !== null,
    };
  }

  /** Turns backup on (or with `null`, off), then pushes once so a wrong URL shows up right away. */
  async set(
    vault: string,
    next: { remote: string; intervalMinutes?: number | undefined } | null,
    author: Author,
  ): Promise<BackupStatus> {
    if (next) this.checkRemote(next.remote);
    const minutes = next?.intervalMinutes ?? DEFAULT_BACKUP_INTERVAL_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
      throw new AppError("invalid_request", undefined, { field: "intervalMinutes" });
    }
    const config = await this.readConfig(vault);
    if (next) config.backup = { remote: next.remote, intervalMinutes: minutes };
    else delete config.backup;
    const note = next ? "Turn on remote backup" : "Turn off remote backup";
    await this.vaults.writeMeta(
      vault,
      VAULT_CONFIG_FILE,
      `${JSON.stringify(config, null, 2)}\n`,
      () =>
        this.history.record(vault, [`${VAULT_META_DIR}/${VAULT_CONFIG_FILE}`], author, {
          summary: note,
        }),
    );
    this.status.delete(vault);
    this.lastAttempt.delete(vault);
    if (next) await this.push(vault);
    else await this.syncRemote(vault, null);
    return this.get(vault);
  }

  /** Pushes every vault whose interval has passed. */
  async pushDue(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const { id } of await this.vaults.listVaults()) {
        const settings = await this.settings(id).catch(() => null);
        if (!settings) continue;
        const last = this.lastAttempt.get(id) ?? 0;
        if (Date.now() - last >= settings.intervalMinutes * 60_000) await this.push(id);
      }
    } catch (err) {
      this.log.error("backup run failed", errorFields(err));
    } finally {
      this.ticking = false;
    }
  }

  /** Commits pending changes and pushes all branches and tags. Never throws; the outcome is in the status. */
  async push(vault: string): Promise<void> {
    this.lastAttempt.set(vault, Date.now());
    try {
      const settings = await this.settings(vault);
      if (!settings) return;
      await this.history.commit(vault);
      const env = this.env(settings.remote);
      await this.syncRemote(vault, settings.remote);
      await this.history.exclusive(vault, (git) =>
        git(
          [
            "push",
            "--quiet",
            "--porcelain",
            REMOTE,
            "refs/heads/*:refs/heads/*",
            "refs/tags/*:refs/tags/*",
          ],
          env,
        ),
      );
      this.status.set(vault, { lastPushAt: new Date().toISOString(), lastError: null });
      this.log.debug("backup pushed", { vault });
    } catch (err) {
      const message = mask(err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.status.set(vault, {
        lastPushAt: this.status.get(vault)?.lastPushAt ?? null,
        lastError: message,
      });
      this.log.warn("backup push failed", { vault, error: message });
    }
  }

  private async settings(vault: string): Promise<BackupSettings | null> {
    const raw = (await this.readConfig(vault)).backup;
    if (typeof raw !== "object" || raw === null) return null;
    const { remote, intervalMinutes } = raw as Record<string, unknown>;
    if (typeof remote !== "string" || !remote) return null;
    return {
      remote,
      intervalMinutes:
        typeof intervalMinutes === "number" && intervalMinutes >= 1
          ? intervalMinutes
          : DEFAULT_BACKUP_INTERVAL_MINUTES,
    };
  }

  private async readConfig(vault: string): Promise<ReturnType<typeof parseVaultConfig>> {
    const text = await this.vaults.readMeta(vault, VAULT_CONFIG_FILE);
    if (text === null) {
      throw new AppError("vault_not_found", undefined, { vault });
    }
    return parseVaultConfig(text);
  }

  /** Makes the git remote match the settings (or removes it). */
  private syncRemote(vault: string, remote: string | null): Promise<void> {
    return this.history.exclusive(vault, async (git) => {
      const current = await git(["remote", "get-url", REMOTE]).then(
        (url) => url.trim(),
        (err) => {
          if (err instanceof GitError) return null;
          throw err;
        },
      );
      if (current === remote) return;
      if (remote === null) await git(["remote", "remove", REMOTE]);
      else if (current === null) await git(["remote", "add", REMOTE, remote]);
      else await git(["remote", "set-url", REMOTE, remote]);
    });
  }

  /** Hands the token to git through the environment, so it never appears on a command line or in a file. */
  private env(remote: string): Record<string, string> | undefined {
    if (!this.credentials || !remote.startsWith("https://")) return undefined;
    const origin = new URL(remote).origin;
    const basic = Buffer.from(`${this.credentials.username}:${this.credentials.token}`).toString(
      "base64",
    );
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
  }

  /**
   * Only network remotes: a local path or file:// URL would let API callers write anywhere on the
   * server. No password or token in the URL either: the settings file is part of the vault's
   * history and would be pushed along with it.
   */
  private checkRemote(remote: string): void {
    const invalid = (reason: string): never => {
      throw new AppError("invalid_backup_remote", undefined, { reason });
    };
    if (/[\s\0]/.test(remote) || remote.startsWith("-"))
      invalid("The URL has spaces or starts with a dash.");
    if (remote.startsWith("https://")) {
      let url: URL;
      try {
        url = new URL(remote);
      } catch {
        return invalid("The URL is not valid.");
      }
      if (url.username || url.password) {
        invalid(
          "Do not put a user name or token in the URL; set PALIMVO_BACKUP_TOKEN on the server.",
        );
      }
      return;
    }
    if (remote.startsWith("ssh://")) {
      let url: URL;
      try {
        url = new URL(remote);
      } catch {
        return invalid("The URL is not valid.");
      }
      if (url.password) invalid("Do not put a password in the URL; use an SSH key.");
      return;
    }
    if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:/.test(remote)) return;
    if (!this.allowLocal) invalid("Use an https://, ssh:// or git@host:path URL.");
  }
}

function credentialsFromEnv(): { username: string; token: string } | null {
  const token = process.env.PALIMVO_BACKUP_TOKEN;
  if (!token) return null;
  return { username: process.env.PALIMVO_BACKUP_USERNAME || "x-access-token", token };
}

/** Hides credentials in URLs such as https://user:token@github.com/... in git's messages. */
function mask(text: string): string {
  return text.replace(/(https?:\/\/)[^/@\s]+@/g, "$1***@");
}
