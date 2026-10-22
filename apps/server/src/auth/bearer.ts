import type { MiddlewareHandler } from "hono";
import { AppError } from "@palimvo/core";
import { bindPrincipal } from "./principal.ts";
import type { AuthService } from "./service.ts";
import type { TokenService } from "./tokens.ts";

/** Where OAuth clients learn how to sign in; the `WWW-Authenticate` challenge points here. */
export const PROTECTED_RESOURCE_METADATA = "/.well-known/oauth-protected-resource";

export interface BearerOptions {
  auth: AuthService;
  tokens: TokenService;
  publicUrl?: string | undefined;
}

/** `Bearer realm="palimvo", resource_metadata="…"`, plus the RFC 6750 error when a token was sent. */
export function challenge(publicUrl: string | undefined, error?: "invalid_token"): string {
  const parts = ['realm="palimvo"'];
  if (error) parts.push(`error="${error}"`);
  if (publicUrl) parts.push(`resource_metadata="${publicUrl}${PROTECTED_RESOURCE_METADATA}"`);
  return `Bearer ${parts.join(", ")}`;
}

/**
 * Authenticates AI calls (`/mcp`) by `Authorization: Bearer`. Cookies are ignored on purpose: a
 * page in the browser must not be able to drive the MCP endpoint with the visitor's session.
 * Without a valid secret the answer is a 401 with the OAuth discovery challenge, which is how
 * Claude.ai and ChatGPT find the sign-in.
 */
export function bearerMiddleware({ auth, tokens, publicUrl }: BearerOptions): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const identity = match?.[1] ? tokens.authenticate(match[1]) : undefined;
    if (!identity) {
      return c.json(new AppError("unauthenticated").toJSON(), 401, {
        "WWW-Authenticate": challenge(publicUrl, match ? "invalid_token" : undefined),
      });
    }
    try {
      tokens.checkRate(identity);
    } catch (err) {
      if (err instanceof AppError && err.code === "rate_limited") {
        const wait = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        return c.json(err.toJSON(), 429, wait ? { "Retry-After": String(wait) } : {});
      }
      throw err;
    }
    bindPrincipal(c, auth, { kind: "token", account: identity.account, bearer: identity });
    await next();
  };
}
