/**
 * The messages between the app and a plugin's sandboxed iframe.
 *
 * Only one message travels over `window.postMessage`: the frame's `hello` and the app's `init`
 * answer, which hands the frame a private `MessagePort`. Everything after that goes over the
 * port, so a page the frame navigates to (it has no port) cannot speak with the app.
 */

export const PROTOCOL_VERSION = 1;

/** Where a plugin's code runs: which contribution the frame draws. */
export type FrameMode =
  | "view"
  | "codeBlock"
  | "component"
  | "viewer"
  | "baseView"
  | "homeWidget"
  | "slot"
  | "app"
  /** A hidden frame that answers other plugins' extension points and slot entries. */
  | "background";

export const RPC_METHODS = [
  "vault.read",
  "vault.readBinary",
  "vault.list",
  "vault.search",
  "vault.queryBase",
  "vault.graph",
  "vault.write",
  "vault.propose",
  "ui.openFile",
  "ui.showNotice",
  "ui.updateSource",
  "extensions.invoke",
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

export const MAX_PENDING_REQUESTS = 64;
export const MAX_REQUEST_IDS = 4096;
export const RPC_TIMEOUT_MS = 30_000;
/** Largest file a plugin may read as bytes. */
export const MAX_BINARY_BYTES = 32 * 1024 * 1024;
/** Largest text a plugin may write or propose in one call. */
export const MAX_WRITE_CHARS = 5_000_000;
/** What an extension call may carry each way, as JSON. */
export const MAX_EXTENSION_BYTES = 1024 * 1024;
export const EXTENSION_TIMEOUT_MS = 10_000;
/** Furthest `vault.graph` may reach around a file. */
export const MAX_GRAPH_DEPTH = 6;
export const MAX_FRAME_HEIGHT = 200_000;

export interface RpcRequest {
  requestId: string;
  method: RpcMethod;
  params: Record<string, unknown>;
}

const PARAM_FIELDS: Record<RpcMethod, readonly string[]> = {
  "vault.read": ["path"],
  "vault.readBinary": ["path"],
  "vault.list": ["dir", "recursive"],
  "vault.search": ["query", "limit", "folder"],
  "vault.queryBase": ["path", "view"],
  "vault.graph": ["around", "depth", "tags"],
  "vault.write": ["path", "content", "reason"],
  "vault.propose": ["path", "content", "title", "reason"],
  "ui.openFile": ["path"],
  "ui.showNotice": ["message", "kind"],
  "ui.updateSource": ["source"],
  "extensions.invoke": ["point", "input"],
};

const STRING_FIELDS = [
  "path",
  "around",
  "dir",
  "query",
  "folder",
  "view",
  "content",
  "reason",
  "title",
  "message",
  "kind",
  "source",
  "point",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Checks the shape of one message from a frame; throws with a reason when it is not a request. */
export function parseRpc(value: unknown): RpcRequest {
  if (!isPlainObject(value)) throw new Error("A request must be an object");
  const { type, schemaVersion, requestId, method, params = {}, ...rest } = value;
  if (type !== "rpc" || Object.keys(rest).length > 0) throw new Error("Unexpected request fields");
  if (schemaVersion !== PROTOCOL_VERSION) throw new Error("Unsupported protocol version");
  if (typeof requestId !== "string" || !/^[\w:-]{1,128}$/.test(requestId))
    throw new Error("Invalid request id");
  if (typeof method !== "string" || !(RPC_METHODS as readonly string[]).includes(method))
    throw new Error("Unknown method");
  if (!isPlainObject(params)) throw new Error("Parameters must be an object");
  const fields = PARAM_FIELDS[method as RpcMethod];
  for (const key of Object.keys(params)) {
    if (!fields.includes(key)) throw new Error(`Unexpected parameter: ${key}`);
  }
  for (const key of STRING_FIELDS) {
    if (params[key] !== undefined && typeof params[key] !== "string")
      throw new Error(`${key} must be a string`);
  }
  if (params.recursive !== undefined && typeof params.recursive !== "boolean")
    throw new Error("recursive must be true or false");
  if (params.tags !== undefined && typeof params.tags !== "boolean")
    throw new Error("tags must be true or false");
  if (params.depth !== undefined) {
    const { depth } = params;
    if (
      typeof depth !== "number" ||
      !Number.isInteger(depth) ||
      depth < 1 ||
      depth > MAX_GRAPH_DEPTH
    )
      throw new Error(`depth must be an integer from 1 to ${MAX_GRAPH_DEPTH}`);
  }
  if (params.limit !== undefined) {
    const { limit } = params;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("limit must be an integer from 1 to 100");
  }
  for (const key of ["content", "source"]) {
    const text = params[key];
    if (typeof text === "string" && text.length > MAX_WRITE_CHARS)
      throw new Error(`${key} is too large`);
  }
  const needsPath = [
    "vault.read",
    "vault.readBinary",
    "vault.write",
    "vault.propose",
    "ui.openFile",
  ];
  if (needsPath.includes(method) && typeof params.path !== "string")
    throw new Error("path is required");
  if (method === "vault.queryBase" && typeof params.path !== "string")
    throw new Error("path is required");
  if (
    (method === "vault.write" || method === "vault.propose") &&
    typeof params.content !== "string"
  )
    throw new Error("content is required");
  if (method === "vault.search" && typeof params.query !== "string")
    throw new Error("query is required");
  if (method === "ui.showNotice" && typeof params.message !== "string")
    throw new Error("message is required");
  if (method === "ui.updateSource" && typeof params.source !== "string")
    throw new Error("source is required");
  if (method === "extensions.invoke" && typeof params.point !== "string")
    throw new Error("point is required");
  return { requestId, method: method as RpcMethod, params: { ...params } };
}

/** JSON round trip: only plain data crosses between sandboxes, never functions or prototypes. */
export function plainData(value: unknown, what: string, limit = MAX_EXTENSION_BYTES): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error(`${what} must be plain data (JSON)`);
  }
  if (json === undefined) return null;
  if (json.length > limit) throw new Error(`${what} is larger than ${limit} bytes`);
  return JSON.parse(json) as unknown;
}

/** The error codes a plugin sees; they match `PluginErrorCode` in the SDK. */
export type RpcErrorCode =
  | "permission_denied"
  | "not_found"
  | "version_conflict"
  | "quota_exceeded"
  | "invalid_argument"
  | "unavailable";

/** A failed call: the frame turns `code` and `message` back into an Error. */
export class RpcError extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}
