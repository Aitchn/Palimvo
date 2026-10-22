import type { Context } from "hono";
import { AppError } from "@palimvo/core";
import type { ZodType } from "zod";
import { principalOf } from "../auth/principal.ts";
import type { AuthService } from "../auth/service.ts";

/** Parses a JSON request body; anything malformed is an `invalid_request` error with the reasons. */
export async function readJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError("invalid_request", undefined, { reason: "body is not JSON" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("invalid_request", undefined, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/** Writes an audit entry attributed to whoever is calling. */
export function auditCall(
  auth: AuthService,
  c: Context,
  action: string,
  fields: { vaultId?: string; targetType?: string; targetId?: string; detail?: unknown } = {},
): void {
  const p = principalOf(c);
  auth.store.audit.append({
    actorType: p.kind === "account" ? "account" : "system",
    ...(p.kind === "account" ? { actorId: p.account.id, actorLabel: p.account.username } : {}),
    action,
    ...(fields.vaultId ? { vaultId: fields.vaultId } : {}),
    ...(fields.targetType ? { targetType: fields.targetType } : {}),
    ...(fields.targetId ? { targetId: fields.targetId } : {}),
    ...(fields.detail === undefined ? {} : { detail: fields.detail }),
  });
}
