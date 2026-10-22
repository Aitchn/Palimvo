import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import {
  ADMIN_GRANT_PERMISSIONS,
  AppError,
  serverScope,
  vaultScope,
  type TokenAccess,
} from "@palimvo/core";
import { negotiate, type Locale } from "@palimvo/i18n";
import {
  OAuthError,
  SUPPORTED_SCOPES,
  type ClientAuthMethod,
  type OAuthService,
} from "../auth/oauth.ts";
import {
  AUTHORIZE_FIELDS,
  PAGE_HEADERS,
  consentPage,
  errorPage,
  signInPage,
  t,
  type AuthorizeFields,
} from "../auth/oauthPages.ts";
import { checkOrigin, clientIp, setSessionCookie, type Principal } from "../auth/principal.ts";
import { SESSION_COOKIE, type AuthService } from "../auth/service.ts";
import type { VaultService } from "../vault/service.ts";
import { FailureLimiter } from "../auth/rateLimit.ts";
import { PROTECTED_RESOURCE_METADATA } from "../auth/bearer.ts";

export interface OAuthRouteDeps {
  auth: AuthService;
  oauth: OAuthService;
  vaults: VaultService;
  publicUrl?: string | undefined;
  trustProxy: boolean;
}

const HOUR = 60 * 60 * 1000;
const REGISTER_MAX_PER_IP = 30;
const TOKEN_FAILURES_PER_IP = 40;
const MAX_FIELD = 4096;

function requirePublicUrl(publicUrl: string | undefined): string {
  if (!publicUrl) throw new AppError("public_url_required");
  return publicUrl;
}

const oauthJson = (c: Context, body: unknown, status: 200 | 201 = 200) =>
  c.json(body, status, { "Cache-Control": "no-store", Pragma: "no-cache" });

function oauthError(c: Context, err: OAuthError) {
  return c.json({ error: err.error, error_description: err.message }, err.status, {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });
}

/** Form values as plain strings; anything else (files, arrays) is dropped. */
async function readForm(c: Context): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  const out: Record<string, string> = {};
  if (type.includes("application/json")) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    return out;
  }
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  for (const [k, v] of Object.entries(form)) if (typeof v === "string") out[k] = v;
  return out;
}

function fieldsOf(source: (name: string) => string | undefined): AuthorizeFields {
  const fields: AuthorizeFields = {};
  for (const name of AUTHORIZE_FIELDS) {
    const v = source(name);
    if (v !== undefined && v.length <= MAX_FIELD) fields[name] = v;
  }
  return fields;
}

function basicCredentials(c: Context): { id: string; secret: string } | undefined {
  const m = /^Basic\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  if (!m?.[1]) return undefined;
  const text = Buffer.from(m[1], "base64").toString("utf8");
  const i = text.indexOf(":");
  if (i < 0) return undefined;
  try {
    return {
      id: decodeURIComponent(text.slice(0, i)),
      secret: decodeURIComponent(text.slice(i + 1)),
    };
  } catch {
    return undefined;
  }
}

/**
 * OAuth 2.1 for MCP clients such as Claude.ai and ChatGPT: discovery documents, dynamic client
 * registration, the sign-in and consent pages, and the token and revocation endpoints. Needs
 * `PALIMVO_PUBLIC_URL`, because the discovery documents and redirects must name the server.
 */
export function oauthRoutes({ auth, oauth, vaults, publicUrl, trustProxy }: OAuthRouteDeps): Hono {
  const app = new Hono();
  const registrations = new FailureLimiter(REGISTER_MAX_PER_IP, HOUR);
  const tokenFailures = new FailureLimiter(TOKEN_FAILURES_PER_IP, 15 * 60 * 1000);
  const secure = publicUrl?.startsWith("https://") ?? false;
  // Behind a reverse proxy at a sub-path, the pages must post and redirect under that path.
  const base = publicUrl ? new URL(publicUrl).pathname.replace(/\/+$/, "") : "";

  // Browser-based MCP clients call these from other origins. None of them uses cookies.
  const open = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"],
  });
  for (const path of ["/.well-known/*", "/oauth/register", "/oauth/token", "/oauth/revoke"])
    app.use(path, open);

  const small = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json(new AppError("payload_too_large").toJSON(), 413),
  });

  // --- Discovery ---------------------------------------------------------------------------

  const resourceMetadata = (c: Context) => {
    const base = requirePublicUrl(publicUrl);
    const suffix = c.req.path.slice(PROTECTED_RESOURCE_METADATA.length);
    // /.well-known/oauth-protected-resource/mcp/<vault> describes /mcp/<vault> (RFC 9728).
    const resource = /^\/mcp(\/[^/]+)?$/.test(suffix) ? suffix : "/mcp";
    return c.json({
      resource: `${base}${resource}`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: [...SUPPORTED_SCOPES],
      resource_name: "Palimvo",
    });
  };
  app.get(PROTECTED_RESOURCE_METADATA, resourceMetadata);
  app.get(`${PROTECTED_RESOURCE_METADATA}/*`, resourceMetadata);

  const serverMetadata = (c: Context) => {
    const base = requirePublicUrl(publicUrl);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [...SUPPORTED_SCOPES],
      authorization_response_iss_parameter_supported: true,
    });
  };
  app.get("/.well-known/oauth-authorization-server", serverMetadata);
  app.get("/.well-known/oauth-authorization-server/*", serverMetadata);

  // --- Dynamic client registration (RFC 7591) ---------------------------------------------------

  app.post("/oauth/register", small, async (c) => {
    requirePublicUrl(publicUrl);
    const ip = clientIp(c, trustProxy);
    if (registrations.retryAfterSeconds(ip) > 0)
      return oauthError(c, new OAuthError("server_error", "Too many registrations.", 429));
    registrations.fail(ip);
    try {
      const body = (await c.req.json().catch(() => undefined)) as
        Record<string, unknown> | undefined;
      if (!body || typeof body !== "object")
        throw new OAuthError("invalid_client_metadata", "The body must be a JSON object.");
      const uris = body.redirect_uris;
      if (!Array.isArray(uris) || !uris.every((u) => typeof u === "string"))
        throw new OAuthError("invalid_redirect_uri", "redirect_uris must be an array of strings.");
      const method = (body.token_endpoint_auth_method ?? "none") as string;
      if (!["none", "client_secret_post", "client_secret_basic"].includes(method))
        throw new OAuthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
      const { client, secret } = oauth.register({
        redirectUris: uris as string[],
        authMethod: method as ClientAuthMethod,
        ...(typeof body.client_name === "string" ? { clientName: body.client_name } : {}),
      });
      return oauthJson(
        c,
        {
          client_id: client.clientId,
          client_name: client.clientName,
          redirect_uris: client.redirectUris,
          client_id_issued_at: Math.floor(client.createdAt / 1000),
          token_endpoint_auth_method: method,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: SUPPORTED_SCOPES.join(" "),
          ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        },
        201,
      );
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(c, err);
      throw err;
    }
  });

  // --- Sign-in and consent pages -------------------------------------------------------------------

  const page = (c: Context, html: string, status: 200 | 400 | 401 | 403 | 429 | 503 = 200) =>
    c.html(html, status, { ...PAGE_HEADERS });

  const localeOf = (c: Context): Locale => negotiate(c.req.header("accept-language"));

  const problem = (c: Context, message: string, status: 400 | 403 | 503 = 400) =>
    page(c, errorPage(localeOf(c), message), status);

  const publicUrlProblem = (c: Context) =>
    problem(c, t(localeOf(c), "errors.public_url_required"), 503);

  /** Sends the person back to the app with an error (only after the return address was checked). */
  const denyTo = (
    redirectUri: string,
    error: string,
    description: string,
    state: string | undefined,
  ): string => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state !== undefined) url.searchParams.set("state", state);
    if (publicUrl) url.searchParams.set("iss", publicUrl);
    return url.toString();
  };

  const signedIn = (c: Context): Extract<Principal, { kind: "account" }> | undefined => {
    const cookie = getCookie(c, SESSION_COOKIE);
    const resolved = auth.resolveSession(cookie);
    if (!resolved || !cookie) return undefined;
    return {
      kind: "account",
      account: resolved.account,
      sessionId: resolved.session.id,
      csrf: resolved.csrf,
      cookie,
    };
  };

  const mayConnect = async (principal: Extract<Principal, { kind: "account" }>) => {
    const access = auth.access.forPrincipal(principal);
    if (access.isServerAdmin) return true;
    const ids = access.visibleVaults((await vaults.listVaults()).map((v) => v.id));
    return ids.some((id) => access.can("mcp.connect", vaultScope(id)));
  };

  /** Whether the person may let an app administer: only what they hold themselves can be handed over. */
  const mayAdminister = (principal: Extract<Principal, { kind: "account" }>) => {
    const access = auth.access.forPrincipal(principal);
    return ADMIN_GRANT_PERMISSIONS.some((p) => access.can(p, serverScope));
  };

  /** Checks an authorize request; either the checked request or the response that ends it. */
  const examine = (c: Context, fields: AuthorizeFields) => {
    const base = requirePublicUrl(publicUrl);
    let client;
    try {
      client = oauth.checkClient(fields.client_id, fields.redirect_uri);
    } catch (err) {
      if (err instanceof OAuthError)
        return { response: problem(c, t(localeOf(c), "oauth.errorClient")) };
      throw err;
    }
    const redirectUri = fields.redirect_uri as string;
    try {
      const request = oauth.checkAuthorize({
        client,
        redirectUri,
        responseType: fields.response_type,
        codeChallenge: fields.code_challenge,
        codeChallengeMethod: fields.code_challenge_method,
        scope: fields.scope,
        state: fields.state,
      });
      if (fields.resource !== undefined && !isOurResource(fields.resource, base))
        throw new OAuthError("invalid_target", "resource is not this server's /mcp endpoint.");
      return { request };
    } catch (err) {
      if (err instanceof OAuthError)
        return {
          response: c.redirect(denyTo(redirectUri, err.error, err.message, fields.state), 303),
        };
      throw err;
    }
  };

  app.get("/oauth/authorize", async (c) => {
    if (!publicUrl) return publicUrlProblem(c);
    if (!auth.hasAccounts) return problem(c, t(localeOf(c), "errors.setup_required"), 403);
    const fields = fieldsOf((name) => c.req.query(name));
    const checked = examine(c, fields);
    if (checked.response) return checked.response;
    const { request } = checked;
    const locale = localeOf(c);
    const principal = signedIn(c);
    if (!principal)
      return page(c, signInPage(locale, { client: request.client.clientName, fields, base }));
    if (!(await mayConnect(principal))) return problem(c, t(locale, "oauth.errorNoVaults"), 403);
    return page(
      c,
      consentPage(locale, {
        client: request.client.clientName,
        redirectHost: new URL(request.redirectUri).host || new URL(request.redirectUri).protocol,
        account: principal.account.displayName,
        csrf: principal.csrf,
        fields,
        base,
        defaultAccess: request.requestedAccess ?? "write",
        canAdminister: mayAdminister(principal),
      }),
    );
  });

  app.post("/oauth/login", small, async (c) => {
    if (!publicUrl) return publicUrlProblem(c);
    checkOrigin(c, publicUrl);
    const form = await readForm(c);
    const fields = fieldsOf((name) => form[name]);
    const checked = examine(c, fields);
    if (checked.response) return checked.response;
    const locale = localeOf(c);
    const ua = c.req.header("user-agent");
    try {
      const signed = await auth.login(form.username ?? "", form.password ?? "", {
        ip: clientIp(c, trustProxy),
        ...(ua ? { userAgent: ua } : {}),
      });
      setSessionCookie(c, signed.cookie, { secure });
      const query = new URLSearchParams(Object.entries(fields) as [string, string][]);
      return c.redirect(`${base}/oauth/authorize?${query.toString()}`, 303);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      return page(
        c,
        signInPage(locale, {
          client: checked.request.client.clientName,
          fields,
          base,
          username: (form.username ?? "").slice(0, 100),
          error: t(locale, `errors.${err.code}`),
        }),
        err.httpStatus === 429 ? 429 : 401,
      );
    }
  });

  app.post("/oauth/authorize", small, async (c) => {
    if (!publicUrl) return publicUrlProblem(c);
    checkOrigin(c, publicUrl);
    const form = await readForm(c);
    const fields = fieldsOf((name) => form[name]);
    const checked = examine(c, fields);
    if (checked.response) return checked.response;
    const { request } = checked;
    const locale = localeOf(c);
    const principal = signedIn(c);
    if (!principal)
      return page(c, signInPage(locale, { client: request.client.clientName, fields, base }), 401);
    if (!auth.csrfMatches(principal.cookie, form.csrf))
      return problem(c, t(locale, "errors.csrf_invalid"), 403);
    if (form.decision !== "allow")
      return c.redirect(
        denyTo(request.redirectUri, "access_denied", "The user denied the request.", request.state),
        303,
      );
    const access = form.access as TokenAccess;
    if (!["read", "propose", "write"].includes(access))
      return problem(c, t(locale, "oauth.errorRequest"));
    if (!(await mayConnect(principal))) return problem(c, t(locale, "oauth.errorNoVaults"), 403);
    // The box is only shown to people who may administer, and only counts with write access.
    const admin = form.admin === "1";
    if (admin && (access !== "write" || !mayAdminister(principal)))
      return problem(c, t(locale, "oauth.errorRequest"));
    const code = oauth.approve(principal.account, request, access, admin);
    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (request.state !== undefined) url.searchParams.set("state", request.state);
    url.searchParams.set("iss", publicUrl);
    return c.redirect(url.toString(), 303);
  });

  // --- Token and revocation endpoints --------------------------------------------------------

  const authenticateClient = (c: Context, form: Record<string, string>) => {
    const basic = basicCredentials(c);
    return oauth.authenticateClient(
      basic?.id ?? form.client_id,
      basic?.secret ?? form.client_secret,
    );
  };

  app.post("/oauth/token", small, async (c) => {
    const base = requirePublicUrl(publicUrl);
    const ip = clientIp(c, trustProxy);
    const wait = tokenFailures.retryAfterSeconds(ip);
    if (wait > 0)
      return c.json(
        { error: "invalid_request", error_description: "Too many failed attempts." },
        429,
        {
          "Retry-After": String(wait),
        },
      );
    try {
      const form = await readForm(c);
      const client = authenticateClient(c, form);
      if (form.resource !== undefined && !isOurResource(form.resource, base))
        throw new OAuthError("invalid_target", "resource is not this server's /mcp endpoint.");
      switch (form.grant_type) {
        case "authorization_code":
          return oauthJson(
            c,
            oauth.exchangeCode(client, {
              code: form.code,
              redirectUri: form.redirect_uri,
              verifier: form.code_verifier,
            }),
          );
        case "refresh_token":
          return oauthJson(c, oauth.refresh(client, form.refresh_token));
        default:
          throw new OAuthError(
            "unsupported_grant_type",
            "Use authorization_code or refresh_token.",
          );
      }
    } catch (err) {
      if (err instanceof OAuthError) {
        if (err.error === "invalid_client" || err.error === "invalid_grant") tokenFailures.fail(ip);
        return oauthError(c, err);
      }
      throw err;
    }
  });

  app.post("/oauth/revoke", small, async (c) => {
    requirePublicUrl(publicUrl);
    try {
      const form = await readForm(c);
      const client = authenticateClient(c, form);
      if (form.token) oauth.revoke(client, form.token);
      return c.body(null, 200, { "Cache-Control": "no-store" });
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(c, err);
      throw err;
    }
  });

  return app;
}

/** An `resource` indicator (RFC 8707) must name this server's MCP endpoint or one of its vaults. */
function isOurResource(resource: string, base: string): boolean {
  const mcp = `${base}/mcp`;
  return resource === mcp || resource.startsWith(`${mcp}/`);
}
