import {
  AppError,
  BaseError,
  baseFile,
  fileKind,
  InvalidPathError,
  linkResolver,
  normalizeVaultPath,
  parseBase,
  queryBase,
  type BaseResult,
  type FileValue,
} from "@palimvo/core";
import { eachFile, vaultFileSource } from "../search/files.ts";
import type { VaultService } from "../vault/service.ts";

/** A database never reads more notes than this; a bigger vault shows its first notes only. */
export const MAX_BASE_NOTES = 20_000;

function cleanPath(raw: string): string {
  try {
    return normalizeVaultPath(raw);
  } catch (err) {
    if (err instanceof InvalidPathError)
      throw new AppError("invalid_path", undefined, { path: raw }, { message: err.message });
    throw err;
  }
}

export interface BaseQueryRequest {
  /** A `.base` file in the vault... */
  path?: string | undefined;
  /** ...or the YAML of a ```base block inside a note. */
  source?: string | undefined;
  /** The note a ```base block is in: `this` in its filters. */
  thisPath?: string | undefined;
  view?: string | number | undefined;
  columns?: string[] | undefined;
}

/** A database's YAML that cannot be read is the caller's mistake, said plainly. */
export function invalidBase(err: unknown): never {
  if (err instanceof BaseError)
    throw new AppError("invalid_request", undefined, undefined, { message: err.message });
  throw err;
}

/**
 * Every note as a database row sees it. Links resolve only among the files `include` accepts,
 * so a row never names a file the caller may not see.
 */
export async function loadBaseFiles(
  vaults: VaultService,
  vault: string,
  include?: (path: string) => boolean,
): Promise<FileValue[]> {
  const all = await vaults.listFiles(vault);
  const paths = include ? all.filter(include) : all;
  const notes = paths.filter((p) => fileKind(p) === "markdown").slice(0, MAX_BASE_NOTES);
  const resolver = linkResolver(paths);
  const files: FileValue[] = [];
  await eachFile(vaultFileSource(vaults), vault, notes, (path, file) => {
    if (file) files.push(baseFile({ path, content: file.content, mtime: file.mtime }, resolver));
  });
  return files;
}

/** Runs one view of a database, returning its rows and (for a file) the version it was read at. */
export async function runBase(
  vaults: VaultService,
  vault: string,
  request: BaseQueryRequest,
  include?: (path: string) => boolean,
): Promise<BaseResult & { version?: string }> {
  let source = request.source;
  let version: string | undefined;
  let path: string | undefined;
  if (request.path !== undefined) {
    path = cleanPath(request.path);
    if (fileKind(path) !== "base")
      throw new AppError(
        "invalid_request",
        undefined,
        { path },
        { message: `${path} is not a .base file` },
      );
    const file = await vaults.readFile(vault, path);
    source = file.content;
    version = file.version;
  }
  if (source === undefined)
    throw new AppError("invalid_request", undefined, {
      issues: [{ path: "path", message: "path or source is required" }],
    });
  let result: BaseResult;
  try {
    const base = parseBase(source);
    const files = await loadBaseFiles(vaults, vault, include);
    const here = request.thisPath === undefined ? path : cleanPath(request.thisPath);
    const thisFile =
      here === undefined
        ? undefined
        : (files.find((f) => f.path === here) ??
          baseFile({ path: here, content: "", mtime: Date.now() }, []));
    result = queryBase(base, files, {
      ...(request.view === undefined ? {} : { view: request.view }),
      ...(thisFile ? { thisFile } : {}),
      ...(request.columns ? { columns: request.columns } : {}),
    });
  } catch (err) {
    return invalidBase(err);
  }
  return version === undefined ? result : { ...result, version };
}
