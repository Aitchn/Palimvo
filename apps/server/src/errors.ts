import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "./log.ts";

/**
 * An error the client should see. `code` is a stable machine-readable identifier (the web app
 * translates it); `message` is English text for logs and API consumers.
 *
 * TODO(T04): move to `@palimvo/core` together with the error-code enum.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: ContentfulStatusCode,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export function errorBody(err: AppError): ErrorBody {
  return err.details === undefined
    ? { code: err.code, message: err.message }
    : { code: err.code, message: err.message, details: err.details };
}

/** Turns thrown errors into `{code, message, details}` JSON. Unknown errors never leak their message. */
export function errorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof AppError) return c.json(errorBody(err), err.status);
    logger.error("unhandled request error", { path: c.req.path, ...errorFields(err) });
    return c.json<ErrorBody>({ code: "internal_error", message: "Internal server error" }, 500);
  };
}

export function errorFields(err: unknown): Record<string, unknown> {
  return err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) };
}
