import { z } from "zod";
import { AppError, dirname, folderScope, normalizeVaultPath, pathKey } from "@palimvo/core";
import type { FileContent } from "@palimvo/core";
import { KeyedMutex } from "../../vault/mutex.ts";
import type { McpDeps } from "../dispatch.ts";
import { defineTool, type AnyTool, type ToolContext, type ToolDef } from "../registry.ts";

export type Ctx = ToolContext<McpDeps>;

export const pathArg = (what = "Path in the vault, e.g. `Projects/Plan.md`.") =>
  z.string().min(1).describe(what);

/** A path from the AI as the vault wants it; a bad one is the AI's mistake, said plainly. */
export function cleanPath(raw: string): string {
  try {
    return normalizeVaultPath(raw);
  } catch (err) {
    throw new AppError(
      "invalid_path",
      undefined,
      { path: raw },
      {
        message: `Invalid path "${raw}"${err instanceof Error ? `: ${err.message}` : ""}`,
      },
    );
  }
}

/**
 * Reads are allowed per vault, but a token limited to folders sees nothing outside them.
 * `can(path)` says whether the caller may read that path; it is always true without a folder limit.
 */
export function readableIn(ctx: Ctx): {
  limited: boolean;
  can(path: string): boolean;
  require(path: string): void;
} {
  const limited = (ctx.access.bearer?.scope.folders?.length ?? 0) > 0;
  const can = (path: string) =>
    !limited || ctx.access.can("note.read", folderScope(ctx.vault, dirname(path)));
  return {
    limited,
    can,
    require(path) {
      if (limited) ctx.access.require("note.read", folderScope(ctx.vault, dirname(path)));
    },
  };
}

/** Records a change with the history, crediting the AI client and its reason. */
export const recorder =
  (ctx: Ctx) =>
  (paths: readonly string[]): void =>
    ctx.deps.history.record(ctx.vault, paths, ctx.author, ctx.note);

const MAX_ATTEMPTS = 8;

/**
 * AI clients tend to edit the same file at the same moment. Their read-modify-writes are queued
 * per file here, so they do not fight over the file's version; a person's or another route's
 * write in between still makes the version check fail, and the change is applied again.
 */
const edits = new KeyedMutex();

/**
 * Reads a file, lets `change` produce its new text, and writes it only if nobody changed the file
 * meanwhile; if somebody did, reads again and re-applies the change (edits are applied to the
 * latest text, so a concurrent edit by a person or another AI is kept). Returns the new version,
 * or `changed: false` when `change` returned the text unchanged.
 */
export async function modifyText(
  ctx: Ctx,
  path: string,
  change: (current: string) => string,
): Promise<{ version: string; changed: boolean }> {
  return edits.run(`${ctx.vault}\0${pathKey(path)}`, () => applyChange(ctx, path, change));
}

async function applyChange(
  ctx: Ctx,
  path: string,
  change: (current: string) => string,
): Promise<{ version: string; changed: boolean }> {
  const { vaults } = ctx.deps;
  let last: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const file: FileContent = await vaults.readFile(ctx.vault, path, { fresh: attempt > 0 });
    const next = change(file.content);
    if (next === file.content) return { version: file.version, changed: false };
    try {
      const written = await vaults.writeFile(ctx.vault, path, next, {
        baseVersion: file.version,
        onWritten: (w) => recorder(ctx)([w.path]),
      });
      return { version: written.version, changed: true };
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== "version_conflict") throw err;
      last = err;
    }
  }
  throw last;
}

/** Where a failed argument is, for messages the AI can act on. */
export const invalid = (message: string, details?: unknown): AppError =>
  new AppError("invalid_request", undefined, details, { message });

/** `defineTool` with the server's dependencies filled in, so the argument types are inferred from `input`. */
export const mcpTool = <S extends z.ZodObject>(def: ToolDef<S, McpDeps>): AnyTool =>
  defineTool<S, McpDeps>(def);
