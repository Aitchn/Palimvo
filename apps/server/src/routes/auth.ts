import { Hono } from "hono";
import { AppError } from "@palimvo/core";
import { z } from "zod";
import {
  checkOrigin,
  clearSessionCookie,
  clientIp,
  principalOf,
  requireAccount,
  setSessionCookie,
} from "../auth/principal.ts";
import { publicAccount, type AuthService } from "../auth/service.ts";
import { readJson } from "./util.ts";

export interface AuthRouteDeps {
  auth: AuthService;
  publicUrl?: string;
  trustProxy: boolean;
}

const loginBody = z.object({ username: z.string().max(100), password: z.string().max(1000) });
const signUpBody = z.object({
  username: z.string().max(100),
  password: z.string().max(1000),
  displayName: z.string().max(80).optional(),
});
const passwordBody = z.object({ current: z.string().max(1000), next: z.string().max(1000) });

/** Signing in and out, who am I, own sessions and password, and accepting invites: `/api/auth/*`. */
export function authRoutes({ auth, publicUrl, trustProxy }: AuthRouteDeps): Hono {
  const app = new Hono();
  const secure = publicUrl?.startsWith("https://") ?? false;
  const cookieOptions = { secure };

  app.post("/api/auth/login", async (c) => {
    checkOrigin(c, publicUrl);
    const { username, password } = await readJson(c, loginBody);
    const ua = c.req.header("user-agent");
    const signed = await auth.login(username, password, {
      ip: clientIp(c, trustProxy),
      ...(ua ? { userAgent: ua } : {}),
    });
    setSessionCookie(c, signed.cookie, cookieOptions);
    return c.json({
      account: publicAccount(signed.account),
      csrfToken: auth.csrfToken(signed.cookie),
    });
  });

  app.post("/api/auth/logout", (c) => {
    const p = principalOf(c);
    if (p.kind === "account") auth.logout(p.sessionId);
    clearSessionCookie(c, cookieOptions);
    return c.body(null, 204);
  });

  app.get("/api/auth/me", (c) => {
    const p = principalOf(c);
    if (p.kind === "account")
      return c.json({
        state: "account",
        account: publicAccount(p.account),
        csrfToken: p.csrf,
      });
    return c.json({ state: p.kind });
  });

  app.post("/api/auth/password", async (c) => {
    const p = requireAccount(c);
    const { current, next } = await readJson(c, passwordBody);
    await auth.changePassword(p.account, current, next, p.sessionId);
    return c.body(null, 204);
  });

  app.get("/api/auth/sessions", (c) => {
    const p = requireAccount(c);
    return c.json({
      sessions: auth.store.sessions.listForAccount(p.account.id).map((s) => ({
        id: s.id,
        current: s.id === p.sessionId,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        ...(s.userAgent ? { userAgent: s.userAgent } : {}),
      })),
    });
  });

  app.delete("/api/auth/sessions/:id", (c) => {
    const p = requireAccount(c);
    const s = auth.store.sessions.get(c.req.param("id"));
    if (!s || s.accountId !== p.account.id) throw new AppError("not_found");
    auth.store.sessions.delete(s.id);
    return c.body(null, 204);
  });

  app.get("/api/auth/invites/:token", (c) => {
    const invite = auth.previewInvite(c.req.param("token"));
    return c.json({
      ...(invite.note ? { note: invite.note } : {}),
      expiresAt: invite.expiresAt,
      vaults: invite.vaults,
      roles: invite.roleIds.flatMap((id) => {
        const r = auth.store.roles.get(id);
        return r ? [{ id: r.id, name: r.name, ...(r.color ? { color: r.color } : {}) }] : [];
      }),
    });
  });

  app.post("/api/auth/invites/:token/accept", async (c) => {
    checkOrigin(c, publicUrl);
    const body = await readJson(c, signUpBody);
    const ua = c.req.header("user-agent");
    const signed = await auth.acceptInvite(c.req.param("token"), body, {
      ip: clientIp(c, trustProxy),
      ...(ua ? { userAgent: ua } : {}),
    });
    setSessionCookie(c, signed.cookie, cookieOptions);
    return c.json(
      { account: publicAccount(signed.account), csrfToken: auth.csrfToken(signed.cookie) },
      201,
    );
  });

  return app;
}
