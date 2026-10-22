import { createHash, timingSafeEqual } from "node:crypto";
import type { TokenAccess } from "@palimvo/core";
import type { Account, OAuthClient, OAuthGrant, Store } from "../store/index.ts";
import {
  OAUTH_ACCESS_PREFIX,
  OAUTH_CODE_PREFIX,
  OAUTH_REFRESH_PREFIX,
  newSecret,
  scopeOfAccess,
  sha256Hex,
} from "./tokens.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const CODE_TTL_MS = 5 * MINUTE;
export const ACCESS_TTL_MS = 60 * MINUTE;
export const REFRESH_TTL_MS = 30 * DAY;
export const MAX_REDIRECT_URIS = 10;
/** Registration is open to anyone who can reach the server, so it is bounded. */
export const MAX_CLIENTS = 2000;
const UNUSED_CLIENT_TTL_MS = 2 * 60 * MINUTE;

export const SUPPORTED_SCOPES = ["mcp:read", "mcp:write", "mcp:propose"] as const;

/** An error in the shape RFC 6749 gives clients (`{error, error_description}`). */
export class OAuthError extends Error {
  constructor(
    readonly error:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "unauthorized_client"
      | "unsupported_grant_type"
      | "invalid_scope"
      | "invalid_target"
      | "invalid_redirect_uri"
      | "invalid_client_metadata"
      | "access_denied"
      | "server_error",
    description: string,
    readonly status: 400 | 401 | 429 = 400,
  ) {
    super(description);
  }
}

const BLOCKED_SCHEMES = new Set([
  "javascript",
  "data",
  "file",
  "vbscript",
  "about",
  "blob",
  "ftp",
  "ws",
  "wss",
  "chrome",
  "view-source",
]);

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Whether a client may register this return address: https, plain http only to this machine
 * (desktop tools listen on a loopback port), or an app's own scheme such as `cursor://…`.
 */
export function redirectUriProblem(uri: string): string | undefined {
  if (uri.length > 2048) return "is too long";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "is not a URL";
  }
  if (url.hash) return "must not contain a fragment";
  if (url.username || url.password) return "must not contain credentials";
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "https") return undefined;
  if (scheme === "http") return isLoopback(url.hostname) ? undefined : "must use https";
  if (BLOCKED_SCHEMES.has(scheme)) return `scheme ${scheme}: is not allowed`;
  return undefined;
}

export interface RegisteredClient {
  client: OAuthClient;
  /** Shown once, only for clients that asked to authenticate with a secret. */
  secret?: string;
}

export type ClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  /** What the app asked for; the person chooses the real level on the consent page. */
  requestedAccess?: TokenAccess;
}

export interface Tokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const base64url = (buf: Buffer) => buf.toString("base64url");
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * OAuth 2.1 authorization server for MCP clients: dynamic client registration, authorization
 * code with PKCE (S256 only), rotating refresh tokens. No HTTP details live here.
 */
export class OAuthService {
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** RFC 7591 dynamic registration. */
  register(meta: {
    clientName?: string;
    redirectUris: string[];
    authMethod: ClientAuthMethod;
  }): RegisteredClient {
    const uris = [...new Set(meta.redirectUris)];
    if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS)
      throw new OAuthError(
        "invalid_redirect_uri",
        `Give between 1 and ${MAX_REDIRECT_URIS} redirect_uris.`,
      );
    for (const uri of uris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw new OAuthError("invalid_redirect_uri", `redirect_uri ${problem}.`);
    }
    // Names are shown to people on the consent page: one plain line.
    const clientName =
      (meta.clientName ?? "")
        .replace(/[\p{Cc}<>]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100) || "Unnamed app";
    this.store.oauth.purgeUnusedClients(this.now() - UNUSED_CLIENT_TTL_MS);
    if (this.store.oauth.clientCount() >= MAX_CLIENTS)
      throw new OAuthError("server_error", "Too many registered apps. Try again later.", 429);
    const secret = meta.authMethod === "none" ? undefined : newSecret("pls_");
    const client = this.store.oauth.registerClient({
      clientName,
      redirectUris: uris,
      ...(secret ? { secretHash: sha256Hex(secret) } : {}),
    });
    this.store.audit.append({
      actorType: "system",
      action: "oauth.client_registered",
      targetType: "oauth_client",
      targetId: client.clientId,
      detail: { clientName, redirectUris: uris },
    });
    return { client, ...(secret ? { secret } : {}) };
  }

  /** Validates the parts of an authorize request that decide where the person goes next. */
  checkClient(clientId: string | undefined, redirectUri: string | undefined): OAuthClient {
    const client = clientId ? this.store.oauth.getClient(clientId) : undefined;
    if (!client) throw new OAuthError("invalid_client", "Unknown client_id.");
    if (!redirectUri || !client.redirectUris.includes(redirectUri))
      throw new OAuthError(
        "invalid_redirect_uri",
        "redirect_uri is not one the client registered.",
      );
    return client;
  }

  /** Validates an authorize request. Throws `OAuthError`; the caller decides whether that may redirect. */
  checkAuthorize(params: {
    responseType?: string | undefined;
    codeChallenge?: string | undefined;
    codeChallengeMethod?: string | undefined;
    scope?: string | undefined;
    client: OAuthClient;
    redirectUri: string;
    state?: string | undefined;
  }): AuthorizeRequest {
    if (params.responseType !== "code")
      throw new OAuthError("invalid_request", "response_type must be code.");
    if (params.codeChallengeMethod !== "S256")
      throw new OAuthError("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    if (!params.codeChallenge || !PKCE_CHALLENGE.test(params.codeChallenge))
      throw new OAuthError("invalid_request", "code_challenge is missing or malformed.");
    const requested = (params.scope ?? "")
      .split(/\s+/)
      .map((s) => /^mcp:(read|write|propose)$/.exec(s)?.[1] as TokenAccess | undefined)
      .find((a) => a !== undefined);
    return {
      client: params.client,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      ...(params.state === undefined ? {} : { state: params.state }),
      ...(requested ? { requestedAccess: requested } : {}),
    };
  }

  /** The person said yes: records the grant and returns the one-time code to give the client. */
  approve(account: Account, request: AuthorizeRequest, access: TokenAccess): string {
    const code = newSecret(OAUTH_CODE_PREFIX);
    this.store.tx(() => {
      const grant = this.store.oauth.createGrant({
        clientId: request.client.clientId,
        accountId: account.id,
        scope: scopeOfAccess(access),
      });
      this.store.oauth.issueToken({
        grantId: grant.id,
        kind: "code",
        tokenHash: sha256Hex(code),
        expiresAt: this.now() + CODE_TTL_MS,
        codeChallenge: request.codeChallenge,
        redirectUri: request.redirectUri,
      });
      this.store.audit.append({
        actorType: "account",
        actorId: account.id,
        actorLabel: account.username,
        action: "oauth.grant_created",
        targetType: "oauth_grant",
        targetId: grant.id,
        detail: { client: request.client.clientName, access },
      });
    });
    return code;
  }

  /** Checks the secret of a confidential client; public clients (no secret) pass. */
  authenticateClient(clientId: string | undefined, secret: string | undefined): OAuthClient {
    const client = clientId ? this.store.oauth.getClient(clientId) : undefined;
    if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);
    if (client.secretHash !== undefined) {
      if (!secret || !safeEqual(sha256Hex(secret), client.secretHash))
        throw new OAuthError("invalid_client", "Wrong client secret.", 401);
    }
    return client;
  }

  exchangeCode(
    client: OAuthClient,
    input: {
      code?: string | undefined;
      redirectUri?: string | undefined;
      verifier?: string | undefined;
    },
  ): Tokens {
    if (!input.code || !input.verifier || !input.redirectUri)
      throw new OAuthError("invalid_request", "code, redirect_uri and code_verifier are required.");
    if (!PKCE_VERIFIER.test(input.verifier))
      throw new OAuthError("invalid_grant", "code_verifier is malformed.");
    const hash = sha256Hex(input.code);
    const seen = this.store.oauth.findToken("code", hash);
    if (seen?.usedAt !== undefined) {
      // A spent code coming back means it leaked: end everything issued from it.
      this.endGrant(seen.grantId, "code_reuse");
      throw new OAuthError("invalid_grant", "The code was already used.");
    }
    const usable = this.store.oauth.getUsableToken("code", hash);
    const grant = usable && this.store.oauth.getGrant(usable.grantId);
    if (!usable || !grant || grant.clientId !== client.clientId)
      throw new OAuthError("invalid_grant", "The code is unknown, expired or for another client.");
    if (usable.redirectUri !== input.redirectUri)
      throw new OAuthError(
        "invalid_grant",
        "redirect_uri does not match the authorization request.",
      );
    const expected = usable.codeChallenge ?? "";
    const actual = base64url(createHash("sha256").update(input.verifier).digest());
    if (!safeEqual(actual, expected))
      throw new OAuthError("invalid_grant", "code_verifier does not match the challenge.");
    // Single use: of two parallel exchanges only one gets to spend the code.
    if (!this.store.oauth.markUsed(usable.id))
      throw new OAuthError("invalid_grant", "The code was already used.");
    return this.issue(grant);
  }

  refresh(client: OAuthClient, refreshToken: string | undefined): Tokens {
    if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required.");
    const hash = sha256Hex(refreshToken);
    const seen = this.store.oauth.findToken("refresh", hash);
    if (seen?.usedAt !== undefined) {
      this.endGrant(seen.grantId, "refresh_reuse");
      throw new OAuthError("invalid_grant", "The refresh token was already used.");
    }
    const usable = this.store.oauth.getUsableToken("refresh", hash);
    const grant = usable && this.store.oauth.getGrant(usable.grantId);
    if (!usable || !grant || grant.clientId !== client.clientId)
      throw new OAuthError("invalid_grant", "The refresh token is unknown, expired or revoked.");
    const account = this.store.accounts.get(grant.accountId);
    if (!account || account.disabled)
      throw new OAuthError("invalid_grant", "The account can no longer connect.");
    if (!this.store.oauth.markUsed(usable.id))
      throw new OAuthError("invalid_grant", "The refresh token was already used.");
    return this.issue(grant);
  }

  /** RFC 7009. Revoking a refresh token ends the whole grant; an access token only itself. */
  revoke(client: OAuthClient, token: string): void {
    const hash = sha256Hex(token);
    for (const kind of ["refresh", "access"] as const) {
      const found = this.store.oauth.findToken(kind, hash);
      if (!found) continue;
      const grant = this.store.oauth.getGrant(found.grantId);
      if (grant?.clientId !== client.clientId) return;
      if (kind === "refresh") this.endGrant(grant.id, "revoked_by_client");
      else this.store.oauth.revokeToken(found.id);
      return;
    }
  }

  private endGrant(grantId: string, reason: string): void {
    if (!this.store.oauth.revokeGrant(grantId)) return;
    const grant = this.store.oauth.getGrant(grantId);
    this.store.audit.append({
      actorType: "system",
      action: "oauth.grant_ended",
      targetType: "oauth_grant",
      targetId: grantId,
      detail: { reason, account: grant?.accountId },
    });
  }

  private issue(grant: OAuthGrant): Tokens {
    const access = newSecret(OAUTH_ACCESS_PREFIX);
    const refresh = newSecret(OAUTH_REFRESH_PREFIX);
    this.store.tx(() => {
      this.store.oauth.issueToken({
        grantId: grant.id,
        kind: "access",
        tokenHash: sha256Hex(access),
        expiresAt: this.now() + ACCESS_TTL_MS,
      });
      this.store.oauth.issueToken({
        grantId: grant.id,
        kind: "refresh",
        tokenHash: sha256Hex(refresh),
        expiresAt: this.now() + REFRESH_TTL_MS,
      });
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: grant.scope,
    };
  }
}
