/**
 * Stable machine-readable error codes. The server answers with a code and an English
 * message; the web app translates `errors.<code>` from `@palimvo/i18n`.
 * Adding a code means adding it here and to every locale file.
 */
export const ERROR_CODES = {
  invalid_request: { status: 400, message: "The request is not valid." },
  invalid_path: { status: 400, message: "The path is not allowed." },
  invalid_tag: { status: 400, message: "That is not a usable checkpoint tag name." },
  invalid_backup_remote: { status: 400, message: "That backup address is not allowed." },
  schema_invalid: { status: 400, message: "The stored data has an invalid format." },
  weak_password: { status: 400, message: "The password is too short or too long." },
  unauthenticated: { status: 401, message: "Sign in to continue." },
  invalid_credentials: { status: 401, message: "The name or password is wrong." },
  account_disabled: { status: 403, message: "This account has been disabled." },
  csrf_invalid: {
    status: 403,
    message: "The request could not be verified. Reload and try again.",
  },
  forbidden: { status: 403, message: "You do not have permission to do this." },
  token_scope_denied: { status: 403, message: "This token does not cover that vault or folder." },
  propose_only: { status: 403, message: "This token can only propose changes." },
  setup_code_required: { status: 403, message: "The setup code is required." },
  setup_required: { status: 403, message: "Finish the first-time setup first." },
  setup_complete: { status: 403, message: "Setup has already been completed." },
  plugin_not_approved: { status: 403, message: "This plugin version has not been approved." },
  not_found: { status: 404, message: "Not found." },
  vault_not_found: { status: 404, message: "The vault does not exist." },
  already_exists: { status: 409, message: "Something with that name already exists." },
  invite_invalid: { status: 410, message: "This invite link is not valid or has expired." },
  version_conflict: { status: 409, message: "The file changed since it was read." },
  schema_too_new: { status: 409, message: "The data was written by a newer version of Palimvo." },
  vault_busy: { status: 423, message: "The vault is busy with another operation." },
  payload_too_large: { status: 413, message: "The content is too large." },
  unsupported_type: { status: 415, message: "That file type is not accepted." },
  rate_limited: { status: 429, message: "Too many requests. Try again later." },
  internal: { status: 500, message: "Something went wrong on the server." },
  not_implemented: { status: 501, message: "This is not supported yet." },
  unavailable: { status: 503, message: "The service is temporarily unavailable." },
  public_url_required: {
    status: 503,
    message: "OAuth needs the server's public address. Set PALIMVO_PUBLIC_URL.",
  },
  git_unavailable: { status: 503, message: "git is not installed on the server." },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

/** The JSON body of every error response. */
export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface AppErrorOptions {
  /** Overrides the default English message; keep it free of secrets. */
  message?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;

  /** @param httpStatus defaults to the status registered for `code` */
  constructor(
    code: ErrorCode,
    httpStatus?: number,
    details?: unknown,
    options: AppErrorOptions = {},
  ) {
    super(
      options.message ?? ERROR_CODES[code].message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus ?? ERROR_CODES[code].status;
    this.details = details;
  }

  toJSON(): ErrorBody {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Turns anything thrown into an AppError; unknown errors become `internal` without leaking their message. */
export function toAppError(value: unknown): AppError {
  return isAppError(value)
    ? value
    : new AppError("internal", undefined, undefined, { cause: value });
}

/** Parses an error response body; returns null when it is not one of ours. */
export function parseErrorBody(value: unknown): ErrorBody | null {
  if (typeof value !== "object" || value === null) return null;
  const { code, message, details } = value as Record<string, unknown>;
  if (!isErrorCode(code) || typeof message !== "string") return null;
  return details === undefined ? { code, message } : { code, message, details };
}
