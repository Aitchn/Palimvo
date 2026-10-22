import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@palimvo/core";
import type { Account, Invite, InviteVault, Session, Store } from "../store/index.ts";
import {
  assertPasswordAllowed,
  burnPasswordCheck,
  hashPassword,
  verifyPassword,
} from "./password.ts";
import { AccessControl } from "./access.ts";
import { FailureLimiter } from "./rateLimit.ts";

export const SESSION_COOKIE = "palimvo_session";
export const CSRF_HEADER = "x-palimvo-csrf";

const DAY = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 14 * DAY;
/** The expiry only slides forward when less than this is left, so reads do not write. */
const SESSION_RENEW_BELOW_MS = 7 * DAY;
export const INVITE_DEFAULT_TTL_MS = 7 * DAY;
export const INVITE_MAX_TTL_MS = 30 * DAY;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_NAME = 10;
const LOGIN_MAX_PER_IP = 40;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface AuthOptions {
  now?: () => number;
}

export interface LoginContext {
  ip: string;
  userAgent?: string;
}

/** What the API tells a client about an account; never the password hash. */
export interface PublicAccount {
  id: string;
  username: string;
  displayName: string;
  serverAdmin: boolean;
  disabled: boolean;
  createdAt: number;
}

export function publicAccount(a: Account): PublicAccount {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    serverAdmin: a.serverAdmin,
    disabled: a.disabled,
    createdAt: a.createdAt,
  };
}

export interface SignedIn {
  account: Account;
  session: Session;
  /** The cookie value; only the browser ever holds it. */
  cookie: string;
}

export interface ResolvedSession {
  account: Account;
  session: Session;
  csrf: string;
  /** The expiry was just pushed forward, so the browser's cookie needs a fresh lifetime too. */
  renewed: boolean;
}

export interface InviteInput {
  createdBy?: string;
  note?: string;
  roleIds?: string[];
  vaults?: InviteVault[];
  ttlMs?: number;
}

export interface SignUp {
  username: string;
  password: string;
  displayName?: string;
}

/**
 * Passwords, sessions, invites and login throttling. Holds no HTTP details; the routes and the
 * middleware turn requests into calls on this class.
 */
export class AuthService {
  private readonly now: () => number;
  private readonly byName: FailureLimiter;
  private readonly byIp: FailureLimiter;
  /** Permission answers for requests; call `access.invalidate()` after changing roles or members. */
  readonly access: AccessControl;

  constructor(
    readonly store: Store,
    options: AuthOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.access = new AccessControl(store);
    this.byName = new FailureLimiter(LOGIN_MAX_PER_NAME, LOGIN_WINDOW_MS, this.now);
    this.byIp = new FailureLimiter(LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS, this.now);
  }

  /** Before the first account exists the server is in setup mode and access is not enforced yet. */
  get hasAccounts(): boolean {
    return this.store.accounts.count() > 0;
  }

  async login(username: string, password: string, ctx: LoginContext): Promise<SignedIn> {
    const nameKey = username.trim().toLowerCase();
    const wait = Math.max(
      this.byName.retryAfterSeconds(nameKey),
      this.byIp.retryAfterSeconds(ctx.ip),
    );
    if (wait > 0) throw new AppError("rate_limited", undefined, { retryAfterSeconds: wait });

    const account = this.store.accounts.getByUsername(username.trim());
    const ok = account
      ? await verifyPassword(password, account.passwordHash)
      : (await burnPasswordCheck(password), false);
    if (!account || !ok) {
      this.byName.fail(nameKey);
      this.byIp.fail(ctx.ip);
      this.audit("auth.login_failed", account, ctx, { username: username.slice(0, 80) });
      throw new AppError("invalid_credentials");
    }
    if (account.disabled) {
      this.audit("auth.login_disabled", account, ctx);
      throw new AppError("account_disabled");
    }
    this.byName.clear(nameKey);
    const signed = this.openSession(account, ctx.userAgent);
    this.audit("auth.login", account, ctx);
    return signed;
  }

  /** Starts a browser session for an account that has just been proven (login, invite, setup). */
  openSession(account: Account, userAgent?: string): SignedIn {
    const cookie = randomBytes(32).toString("base64url");
    const session = this.store.sessions.create({
      id: sha256(cookie),
      accountId: account.id,
      expiresAt: this.now() + SESSION_TTL_MS,
      ...(userAgent ? { userAgent: userAgent.slice(0, 300) } : {}),
    });
    return { account, session, cookie };
  }

  /** The signed-in account for a cookie value, or undefined for a missing, expired or disabled session. */
  resolveSession(cookie: string | undefined): ResolvedSession | undefined {
    if (!cookie) return undefined;
    const session = this.store.sessions.getValid(sha256(cookie));
    if (!session) return undefined;
    const account = this.store.accounts.get(session.accountId);
    if (!account || account.disabled) return undefined;
    const renewed = session.expiresAt - this.now() < SESSION_RENEW_BELOW_MS;
    if (renewed) this.store.sessions.touch(session.id, this.now() + SESSION_TTL_MS);
    return { account, session, csrf: this.csrfToken(cookie), renewed };
  }

  /** Bound to the session cookie, which scripts on other sites cannot read. */
  csrfToken(cookie: string): string {
    return createHmac("sha256", "palimvo-csrf-v1").update(cookie).digest("base64url");
  }

  csrfMatches(cookie: string, supplied: string | undefined): boolean {
    if (!supplied) return false;
    const a = Buffer.from(this.csrfToken(cookie));
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  logout(sessionId: string): void {
    this.store.sessions.delete(sessionId);
  }

  /** Changes the password and signs out every other device. */
  async changePassword(
    account: Account,
    current: string,
    next: string,
    keepSessionId: string,
  ): Promise<void> {
    if (!(await verifyPassword(current, account.passwordHash)))
      throw new AppError("invalid_credentials");
    assertPasswordAllowed(next);
    const passwordHash = await hashPassword(next);
    this.store.tx(() => {
      this.store.accounts.update(account.id, { passwordHash });
      this.store.sessions.deleteForAccount(account.id, keepSessionId);
    });
    this.store.audit.append({
      actorType: "account",
      actorId: account.id,
      actorLabel: account.username,
      action: "auth.password_changed",
      targetType: "account",
      targetId: account.id,
    });
  }

  /** Administrator sets a new password; every session of that account ends. */
  async resetPassword(actor: Account, targetId: string, password: string): Promise<void> {
    assertPasswordAllowed(password);
    const passwordHash = await hashPassword(password);
    this.store.tx(() => {
      this.store.accounts.update(targetId, { passwordHash });
      this.store.sessions.deleteForAccount(targetId);
    });
    this.store.audit.append({
      actorType: "account",
      actorId: actor.id,
      actorLabel: actor.username,
      action: "admin.password_reset",
      targetType: "account",
      targetId,
    });
  }

  async createAccount(input: SignUp & { serverAdmin?: boolean }): Promise<Account> {
    assertUsername(input.username);
    assertPasswordAllowed(input.password);
    return this.store.accounts.create({
      username: input.username.trim(),
      ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
      passwordHash: await hashPassword(input.password),
      ...(input.serverAdmin ? { serverAdmin: true } : {}),
    });
  }

  /** Returns the invite and its secret; the secret cannot be read again. */
  createInvite(input: InviteInput): { invite: Invite; token: string } {
    const ttl = Math.min(Math.max(input.ttlMs ?? INVITE_DEFAULT_TTL_MS, 60_000), INVITE_MAX_TTL_MS);
    for (const id of input.roleIds ?? []) this.store.roles.require(id);
    const token = randomBytes(24).toString("base64url");
    const invite = this.store.invites.create({
      tokenHash: sha256(token),
      expiresAt: this.now() + ttl,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.roleIds ? { roleIds: input.roleIds } : {}),
      ...(input.vaults ? { vaults: input.vaults } : {}),
    });
    return { invite, token };
  }

  previewInvite(token: string): Invite {
    const invite = this.store.invites.getUsable(sha256(token));
    if (!invite) throw new AppError("invite_invalid");
    return invite;
  }

  /** Creates the account the invite allows, applies its roles and vaults, and signs the person in. */
  async acceptInvite(token: string, input: SignUp, ctx: LoginContext): Promise<SignedIn> {
    const invite = this.previewInvite(token);
    assertUsername(input.username);
    assertPasswordAllowed(input.password);
    const passwordHash = await hashPassword(input.password);
    const account = this.store.tx(() => {
      const created = this.store.accounts.create({
        username: input.username.trim(),
        ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
        passwordHash,
      });
      // Someone may have used the link while the password was being hashed.
      if (!this.store.invites.markUsed(invite.id, created.id)) throw new AppError("invite_invalid");
      for (const roleId of invite.roleIds) {
        if (this.store.roles.get(roleId)) this.store.grantRole(roleId, created.id);
      }
      for (const v of invite.vaults) this.store.joinVault(v.vaultId, created.id, v.position);
      return created;
    });
    this.audit("auth.invite_accepted", account, ctx, { invite: invite.id });
    return this.openSession(account, ctx.userAgent);
  }

  private audit(
    action: string,
    account: Account | undefined,
    ctx: LoginContext,
    detail?: unknown,
  ): void {
    this.store.audit.append({
      actorType: account ? "account" : "system",
      ...(account ? { actorId: account.id, actorLabel: account.username } : {}),
      action,
      ...(detail === undefined ? {} : { detail }),
      ip: ctx.ip,
    });
  }
}

const USERNAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{1,31}$/u;

export function assertUsername(name: string): void {
  if (!USERNAME.test(name.trim()))
    throw new AppError("invalid_request", undefined, {
      issues: [{ path: "username", message: "2-32 letters, digits, dots, dashes or underscores" }],
    });
}
