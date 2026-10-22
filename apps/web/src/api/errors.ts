import type { TFunction } from "i18next";
import { isErrorCode, type ErrorCode } from "@palimvo/core";

/** Codes the server sends, plus two the browser raises itself. */
export type ApiErrorCode = ErrorCode | "network" | "unknown";

/** A failed API call. `code` picks the translated message; `message` is the server's English text. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Builds an {@link ApiError} from a non-2xx response; tolerates bodies that are not our JSON. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    /* not JSON: a proxy page or an empty body */
  }
  if (body && typeof body === "object") {
    const { code, message, details } = body as Record<string, unknown>;
    if (isErrorCode(code)) {
      return new ApiError(
        code,
        response.status,
        typeof message === "string" ? message : code,
        details,
      );
    }
  }
  return new ApiError("unknown", response.status, response.statusText || "Request failed");
}

/** The sentence to show a person for any thrown value, in the interface language. */
export function describeError(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    const values = error.details && typeof error.details === "object" ? error.details : {};
    return t(`errors.${error.code}`, { ...values, defaultValue: t("errors.unknown") });
  }
  return t("errors.unknown");
}
