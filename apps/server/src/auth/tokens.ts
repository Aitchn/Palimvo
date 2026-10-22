import { createHash, randomBytes } from "node:crypto";
import { AppError, normalizeVaultPath, type TokenAccess, type TokenScope } from "@palimvo/core";
import type { Account, ApiToken, Store } from "../store/index.ts";
import { RateWindow } from "./rateLimit.ts";

/** Leading letters that tell the kinds of random credentials apart. */
export const KIND_TAG = { api: "plm_", access: "plo_", refresh: "plr_", code: "plc_" } as const;

const DAY = 24 * 60 * 60 * 1000;
export const TOKEN_DEFAULT_TTL_DAYS = 90;
export const TOKEN_MAX_TTL_DAYS = 365;
/** Calls a minute for a token or OAuth grant without its own limit. */
export const DEFAULT_RATE_PER_MINUTE = 600;
export const MAX_RATE_PER_MINUTE = 6000;
export const MAX_ACTIVE_TOKENS_PER_ACCOUNT = 100;
export const MAX_TOKEN_FOLDERS = 20;
/** `last_used_at` is written at most this often per token, so reads do not turn into writes. */
const TOUCH_EVERY_MS = 60_000;

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export function newCredential(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** The access level an OAuth grant carries in its `scope` ("mcp:read", "mcp:write", "mcp:propose"). */
export function accessOfScope(scope: string): TokenAccess {
  const found = scope
    .split(/\s+/)
    .map((s) => /^mcp:(read|write|propose)$/.exec(s)?.[1])
    .find((a) => a !== undefined);
  return (found as TokenAccess | undefined) ?? "write";
}

export function scopeOfAccess(access: TokenAccess): string {
  return `mcp:${access}`;
}

/** Who a bearer secret speaks for, and the most it may do. */
export interface BearerIdentity {
  account: Account;
  /** What the secret itself is limited to; the person's own rights narrow it further on every call. */
  scope: TokenScope;
  source: "api-token" | "oauth";
  /** The API token id or the OAuth grant id. */
  sourceId: string;
  label: string;
}

export interface NewTokenInput {
  name: string;
  access: TokenAccess;
  vaultId?: string | undefined;
  folders?: readonly string[] | undefined;
  /** Days until it stops working; null never expires. Default 90. */
  expiresInDays?: number | null | undefined;
  rateLimitPerMinute?: number | undefined;
}

/**
 * AI tokens: creating, checking and revoking the secrets that let an AI call `/mcp`. The secret
 * only decides who is calling and the outer limit; what the call may do is recomputed from the
 * person's current roles on every request, so demoting or removing the person narrows their
 * tokens at once.
 */
export class TokenService {
  private readonly now: () => number;
  private readonly rate = new RateWindow(60_000);
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly store: Store,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  create(account: Account, input: NewTokenInput): { token: ApiToken; secret: string } {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 80) throw badRequest("name", "1-80 characters");
    const folders = normalizeFolders(input.folders);
    if (folders.length > 0 && input.vaultId === undefined)
      throw badRequest("folders", "folders need a vault");
    const days = input.expiresInDays === undefined ? TOKEN_DEFAULT_TTL_DAYS : input.expiresInDays;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > TOKEN_MAX_TTL_DAYS))
      throw badRequest("expiresInDays", `1-${TOKEN_MAX_TTL_DAYS} days or null`);
    const rate = input.rateLimitPerMinute;
    if (rate !== undefined && (!Number.isInteger(rate) || rate < 1 || rate > MAX_RATE_PER_MINUTE))
      throw badRequest("rateLimitPerMinute", `1-${MAX_RATE_PER_MINUTE}`);

    const secret = newCredential(KIND_TAG.api);
    const token = this.store.tx(() => {
      const active = this.store.tokens
        .listForAccount(account.id)
        .filter((t) => this.isActive(t)).length;
      if (active >= MAX_ACTIVE_TOKENS_PER_ACCOUNT)
        throw new AppError("rate_limited", 429, {
          reason: `at most ${MAX_ACTIVE_TOKENS_PER_ACCOUNT} active tokens`,
        });
      return this.store.tokens.create({
        accountId: account.id,
        name,
        tokenHash: sha256Hex(secret),
        access: input.access,
        ...(input.vaultId === undefined ? {} : { vaultId: input.vaultId }),
        folders,
        ...(rate === undefined ? {} : { rateLimitPerMinute: rate }),
        ...(days === null ? {} : { expiresAt: this.now() + days * DAY }),
      });
    });
    this.store.audit.append({
      actorType: "account",
      actorId: account.id,
      actorLabel: account.username,
      action: "token.created",
      targetType: "api_token",
      targetId: token.id,
      ...(token.vaultId ? { vaultId: token.vaultId } : {}),
      detail: { name, access: token.access, folders, expiresAt: token.expiresAt ?? null },
    });
    return { token, secret };
  }

  isActive(t: ApiToken): boolean {
    return t.revokedAt === undefined && (t.expiresAt === undefined || t.expiresAt > this.now());
  }

  /** Revokes a token. `actor` is who did it (the owner or an administrator). */
  revoke(actor: Account, token: ApiToken): void {
    if (!this.store.tokens.revoke(token.id)) return;
    this.store.audit.append({
      actorType: "account",
      actorId: actor.id,
      actorLabel: actor.username,
      action: "token.revoked",
      targetType: "api_token",
      targetId: token.id,
      detail: { owner: token.accountId, name: token.name },
    });
  }

  /**
   * The identity behind a bearer secret (an API token or an OAuth access token), or undefined
   * when it is unknown, expired, revoked, or its owner is disabled.
   */
  authenticate(secret: string): BearerIdentity | undefined {
    const hash = sha256Hex(secret);
    if (secret.startsWith(KIND_TAG.api)) {
      const token = this.store.tokens.getActiveByHash(hash);
      if (!token) return undefined;
      const account = this.activeAccount(token.accountId);
      if (!account) return undefined;
      this.touch(`t:${token.id}`, () => this.store.tokens.markUsed(token.id));
      return {
        account,
        scope: {
          access: token.access,
          ...(token.vaultId === undefined ? {} : { vaultId: token.vaultId }),
          folders: token.folders,
        },
        source: "api-token",
        sourceId: token.id,
        label: token.name,
      };
    }
    if (secret.startsWith(KIND_TAG.access)) {
      const issued = this.store.oauth.getUsableToken("access", hash);
      if (!issued) return undefined;
      const grant = this.store.oauth.getGrant(issued.grantId);
      if (!grant || grant.revokedAt !== undefined) return undefined;
      const account = this.activeAccount(grant.accountId);
      if (!account) return undefined;
      const client = this.store.oauth.getClient(grant.clientId);
      return {
        account,
        scope: { access: accessOfScope(grant.scope), folders: [] },
        source: "oauth",
        sourceId: grant.id,
        label: client?.clientName ?? "OAuth app",
      };
    }
    return undefined;
  }

  /** Counts one call; throws `rate_limited` (with the seconds to wait) once the limit is used up. */
  checkRate(identity: BearerIdentity): void {
    const limit =
      identity.source === "api-token"
        ? (this.store.tokens.get(identity.sourceId)?.rateLimitPerMinute ?? DEFAULT_RATE_PER_MINUTE)
        : DEFAULT_RATE_PER_MINUTE;
    const wait = this.rate.hit(`${identity.source}:${identity.sourceId}`, limit, this.now());
    if (wait > 0) throw new AppError("rate_limited", 429, { retryAfterSeconds: wait });
  }

  private activeAccount(id: string): Account | undefined {
    const account = this.store.accounts.get(id);
    return account && !account.disabled ? account : undefined;
  }

  private touch(key: string, write: () => void): void {
    const now = this.now();
    const last = this.touched.get(key);
    if (last !== undefined && now - last < TOUCH_EVERY_MS) return;
    if (this.touched.size > 10_000) this.touched.clear();
    this.touched.set(key, now);
    write();
  }
}

function normalizeFolders(folders: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const f of folders ?? []) {
    let path: string;
    try {
      path = normalizeVaultPath(f);
    } catch {
      throw badRequest("folders", `"${f.slice(0, 80)}" is not a folder path`);
    }
    if (path !== "") out.add(path);
  }
  if (out.size > MAX_TOKEN_FOLDERS) throw badRequest("folders", `at most ${MAX_TOKEN_FOLDERS}`);
  return [...out];
}

function badRequest(path: string, message: string): AppError {
  return new AppError("invalid_request", undefined, { issues: [{ path, message }] });
}
