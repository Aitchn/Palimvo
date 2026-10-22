import { randomInt, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError, maskOf } from "@palimvo/core";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Logger } from "../log.ts";
import type { Account, Store } from "../store/index.ts";
import { isLoopbackHost } from "../config/index.ts";
import { assertPasswordAllowed, hashPassword } from "./password.ts";
import { assertUsername } from "./service.ts";
import { FailureLimiter } from "./rateLimit.ts";

export const SETUP_TOKEN_FILE = "setup-token";

/** No look-alike characters (0/O, 1/I/L), so the code survives being read off a terminal. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 16;

const WINDOW_MS = 15 * 60 * 1000;
const MAX_WRONG_CODES = 10;

export function generateSetupCode(): string {
  const chars = Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!,
  );
  return (chars.join("").match(/.{4}/g) ?? []).join("-");
}

const normalizeCode = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();

/** Headers a reverse proxy or tunnel adds. Their presence means the caller is not at this machine. */
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "via",
  "cf-connecting-ip",
  "cf-ray",
];

const isLoopbackAddress = (address: string | undefined) =>
  address !== undefined && isLoopbackHost(address.replace(/^::ffff:/i, ""));

/** The host name in a `Host` header, without port. */
const hostName = (host: string) => host.replace(/:\d*$/, "");

/**
 * True only for a request typed on this very machine. Behind a reverse proxy or tunnel on the same
 * host every request arrives from loopback, so the caller must also show no forwarding headers and
 * address the server as localhost (a page on another site cannot make a browser do that: DNS
 * rebinding would carry the attacker's host name instead).
 */
export function isLocalRequest(
  remoteAddress: string | undefined,
  header: (name: string) => string | undefined,
): boolean {
  if (!isLoopbackAddress(remoteAddress)) return false;
  if (FORWARDING_HEADERS.some((h) => header(h) !== undefined)) return false;
  const host = header("host");
  return host !== undefined && isLoopbackHost(hostName(host));
}

export function requestIsLocal(c: Context): boolean {
  let address: string | undefined;
  try {
    address = getConnInfo(c).remote.address;
  } catch {
    return false;
  }
  return isLocalRequest(address, (name) => c.req.header(name));
}

export interface SetupInput {
  username: string;
  password: string;
  displayName?: string;
  vault: string;
  sample: boolean;
}

export interface SetupResult {
  account: Account;
  vault: string;
}

/** The roles every new server starts with (plan §12.4); administrators can rename or delete them. */
export const DEFAULT_ROLES = [
  { name: "Creator", color: "#3b82f6", position: 10, permissions: ["vaults.create"] },
  { name: "AI user", color: "#8b5cf6", position: 20, permissions: ["assistant.use"] },
  // Its effect (no writing) is a per-vault override added when the person is given the role.
  { name: "Reader", color: "#64748b", position: 30, permissions: [] },
] as const;

/**
 * The first-time setup: while no account exists the server only answers the setup endpoints.
 * A one-time code is written to `<data>/setup-token` and logged; a request typed on this machine
 * does not need it. Completing setup creates the administrator, the default roles and the first
 * vault, then deletes the code.
 */
export class SetupService {
  private readonly wrongCodes: FailureLimiter;
  private running = false;
  private code: string | undefined;

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly options: {
      /** Run the wizard even though `--dev-insecure` keeps the API open. */
      devInsecure: boolean;
      logger: Logger;
      now?: () => number;
    },
  ) {
    this.wrongCodes = new FailureLimiter(MAX_WRONG_CODES, WINDOW_MS, options.now);
  }

  get tokenFile(): string {
    return path.join(this.dataDir, SETUP_TOKEN_FILE);
  }

  get complete(): boolean {
    return this.store.accounts.count() > 0;
  }

  /** Prepares the code at startup, or removes a stale one when an account already exists. */
  async init(): Promise<{ code: string } | undefined> {
    if (this.complete || this.options.devInsecure) {
      await rm(this.tokenFile, { force: true });
      return undefined;
    }
    let code: string | undefined;
    try {
      code = (await readFile(this.tokenFile, "utf8")).trim();
    } catch {
      // No file yet.
    }
    if (!code || normalizeCode(code).length !== CODE_LENGTH) {
      code = generateSetupCode();
      await writeFile(this.tokenFile, code + "\n", { mode: 0o600 });
      await chmod(this.tokenFile, 0o600).catch(() => undefined);
    }
    this.code = code;
    return { code };
  }

  /** Whether this caller must show the code. */
  needsCode(local: boolean): boolean {
    return !this.complete && !this.options.devInsecure && !local;
  }

  async finish(
    input: SetupInput,
    ctx: { local: boolean; ip: string; code?: string },
    createVault: (id: string, sample: boolean) => Promise<void>,
    removeVault: (id: string) => Promise<void>,
  ): Promise<SetupResult> {
    if (this.complete || this.running) throw new AppError("setup_complete");
    if (this.needsCode(ctx.local)) this.checkCode(ctx.code, ctx.ip);

    assertUsername(input.username);
    assertPasswordAllowed(input.password);
    this.running = true;
    let vaultCreated = false;
    try {
      const passwordHash = await hashPassword(input.password);
      await createVault(input.vault, input.sample);
      vaultCreated = true;
      const account = this.store.tx(() => {
        // The check and the insert are one transaction, so two requests cannot both win.
        if (this.store.accounts.count() > 0) throw new AppError("setup_complete");
        const created = this.store.accounts.create({
          username: input.username.trim(),
          ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
          passwordHash,
          serverAdmin: true,
        });
        this.createDefaultRoles();
        this.store.accounts.setMember(input.vault, created.id, "admin");
        this.store.settings.set("setup.completedAt", Date.now());
        this.store.audit.append({
          actorType: "account",
          actorId: created.id,
          actorLabel: created.username,
          action: "setup.completed",
          detail: { vault: input.vault, sample: input.sample, local: ctx.local },
          ip: ctx.ip,
        });
        return created;
      });
      this.wrongCodes.clear(ctx.ip);
      this.code = undefined;
      await rm(this.tokenFile, { force: true });
      this.options.logger.info("setup completed", { admin: account.username, vault: input.vault });
      return { account, vault: input.vault };
    } catch (err) {
      if (vaultCreated) await removeVault(input.vault).catch(() => undefined);
      throw err;
    } finally {
      this.running = false;
    }
  }

  private createDefaultRoles(): void {
    if (!this.store.roles.getEveryone())
      this.store.roles.create({ name: "@everyone", position: 0, isEveryone: true });
    for (const r of DEFAULT_ROLES)
      this.store.roles.create({
        name: r.name,
        color: r.color,
        position: r.position,
        permissions: maskOf(r.permissions),
      });
  }

  private checkCode(supplied: string | undefined, ip: string): void {
    const wait = this.wrongCodes.retryAfterSeconds(ip);
    if (wait > 0) throw new AppError("rate_limited", undefined, { retryAfterSeconds: wait });
    const expected = this.code;
    const a = Buffer.from(normalizeCode(supplied ?? ""));
    const b = Buffer.from(normalizeCode(expected ?? ""));
    const ok = expected !== undefined && a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      this.wrongCodes.fail(ip);
      throw new AppError("setup_code_required");
    }
  }
}
