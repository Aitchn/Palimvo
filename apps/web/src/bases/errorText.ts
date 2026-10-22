import type { TFunction } from "i18next";
import { ApiError, describeError } from "../api/errors.ts";

/**
 * The sentence for a failed database call. A database whose YAML does not parse comes back as
 * `invalid_request` with the parser's own message, which says what to fix; other errors use the
 * translated text for their code.
 */
export function baseErrorText(t: TFunction, error: unknown): string {
  if (error instanceof ApiError && error.code === "invalid_request" && error.message !== error.code)
    return error.message;
  return describeError(t, error);
}
