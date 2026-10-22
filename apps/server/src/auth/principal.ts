import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AppError } from "@palimvo/core";
import type { Account } from "../store/index.ts";
import { attachAccess } from "./access.ts";
import { PublicPolicy } from "./publicPolicy.ts";
import { CSRF_HEADER, SESSION_COOKIE, SESSION_TTL_MS, type AuthService } from "./service.ts";

/**
 * Who a request comes from.
 * - `open`: no account exists yet (setup mode), so nothing is enforced; the server listens on
 *   loopback unless told otherwise.
 * - `guest`: nobody is signed in; may read only what is made public.
 * - `account`: a signed-in person.
 */
export type Principal =
  | { kind: "open" }
  | { kind: "guest" }
  | { kind: "account"; account: Account; sessionId: string; csrf: string; cookie: string };

const principals = new WeakMap<Request, Principal>();

export function principalOf(c: Context): Principal {
  return principals.get(c.req.raw) ?? { kind: "guest" };
}

export function requireAccount(c: Context): Extract<Principal, { kind: "account" }> {
  const p = principalOf(c);
  if (p.kind !== "account") throw new AppError("unauthenticated");
  return p;
}

/** The public parts of a vault when the caller is a guest; undefined for everyone else. */
export function guestPolicy(
  auth: AuthService,
  c: Context,
  vault: string,
): PublicPolicy | undefined {
  return principalOf(c).kind === "guest"
    ? new PublicPolicy(auth.store.publicAccess.list(vault))
    : undefined;
}

/** Vault ids a guest can see something of. */
export function guestVaultIds(auth: AuthService): Set<string> {
  return new Set(auth.store.publicAccess.vaultIds());
}

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface CookieOptions {
  secure: boolean;
}

export function setSessionCookie(c: Context, value: string, { secure }: CookieOptions): void {
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context, { secure }: CookieOptions): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The origin the browser should be on, to compare with the `Origin` header of unsafe requests. */
function expectedOrigin(c: Context, publicUrl: string | undefined): string {
  if (publicUrl) return new URL(publicUrl).origin;
  return new URL(c.req.url).origin;
}

export interface PrincipalOptions {
  auth: AuthService;
  publicUrl?: string;
}

/**
 * Works out who is calling and, for cookie sessions, enforces CSRF protection on unsafe methods:
 * the `Origin` header (when sent) must be this site, and `X-Palimvo-Csrf` must carry the token
 * `GET /api/auth/me` returned. Requests without a session cookie have no ambient credentials and
 * need neither.
 */
export function principalMiddleware({ auth, publicUrl }: PrincipalOptions): MiddlewareHandler {
  return async (c, next) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    const resolved = auth.resolveSession(cookie);
    let principal: Principal;
    if (resolved && cookie) {
      principal = {
        kind: "account",
        account: resolved.account,
        sessionId: resolved.session.id,
        csrf: resolved.csrf,
        cookie,
      };
      if (!SAFE_METHODS.has(c.req.method)) {
        const origin = c.req.header("origin");
        if (origin && origin !== expectedOrigin(c, publicUrl)) throw new AppError("csrf_invalid");
        if (!auth.csrfMatches(cookie, c.req.header(CSRF_HEADER)))
          throw new AppError("csrf_invalid");
      }
    } else {
      principal = auth.hasAccounts ? { kind: "guest" } : { kind: "open" };
    }
    principals.set(c.req.raw, principal);
    attachAccess(c, auth.access, principal);
    if (resolved?.renewed && cookie)
      setSessionCookie(c, cookie, { secure: publicUrl?.startsWith("https://") ?? false });
    await next();
  };
}

/** Pre-session endpoints (login, invite sign-up) have no token yet, so only the origin is checked. */
export function checkOrigin(c: Context, publicUrl: string | undefined): void {
  const origin = c.req.header("origin");
  if (origin && origin !== expectedOrigin(c, publicUrl)) throw new AppError("csrf_invalid");
}

const GUEST_READS = [
  /^\/api\/vaults$/,
  /^\/api\/vaults\/[^/]+\/files(\/.*)?$/,
  /^\/api\/vaults\/[^/]+\/search$/,
];

/**
 * Applies the first access rules to every `/api` call: guests may only read the vault list, tree,
 * files and search (the routes filter what they return); everything else needs a sign-in. Which
 * signed-in person may do what is decided per route with `accessOf(c).require(...)`.
 */
export function accessGate(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith("/api/") || path === "/api/health" || path.startsWith("/api/auth/"))
      return next();
    const principal = principalOf(c);
    if (principal.kind === "guest") {
      const allowed = c.req.method === "GET" && GUEST_READS.some((re) => re.test(path));
      if (!allowed) throw new AppError("unauthenticated");
    }
    return next();
  };
}
