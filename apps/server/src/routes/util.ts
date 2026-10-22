import type { Context } from "hono";
import { AppError } from "@palimvo/core";
import type { ZodType } from "zod";

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
