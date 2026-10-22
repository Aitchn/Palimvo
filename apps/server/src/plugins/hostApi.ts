import { isAppError, makeAuthor, vaultScope } from "@palimvo/core";
import type { Author } from "@palimvo/core";
import { resolveLocalized, type PluginManifest } from "@palimvo/plugin-sdk";
import type { HostFunctions } from "./sandbox/index.ts";
import { cleanPath, readableIn, type Ctx } from "../mcp/tools/shared.ts";
import { pluginMayAccess } from "./summary.ts";

/** Most one `vault.read` returns, and the most one `vault.write` accepts. */
export const MAX_HOST_TEXT_BYTES = 1024 * 1024;
const MAX_LIST = 2000;
const MAX_SEARCH = 50;
const WRITE_ATTEMPTS = 8;

/** Who the history credits for a plugin's change: the plugin, acting for the AI client that called it. */
export function pluginAuthor(manifest: PluginManifest, on: Author): Author {
  return makeAuthor("plugin", resolveLocalized(manifest.name, "en"), {
    id: manifest.id,
    client: on.name,
  });
}

const denied = (what: string): Error =>
  new Error(`permission_denied: this plugin may not ${what}. Check its declared folders.`);

/** Host calls fail with plain errors the plugin can catch; the message is all it sees. */
function asPluginError(err: unknown): Error {
  if (isAppError(err)) return new Error(`${err.code}: ${err.message}`);
  if (err instanceof Error && err.message.startsWith("permission_denied")) return err;
  return new Error("unavailable: the vault could not complete that");
}

function object(args: unknown, what: string): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    throw new Error(`invalid_argument: ${what} takes one object`);
  return args as Record<string, unknown>;
}

function string(value: unknown, name: string, max = MAX_HOST_TEXT_BYTES): string {
  if (typeof value !== "string") throw new Error(`invalid_argument: ${name} must be a string`);
  if (Buffer.byteLength(value) > max) throw new Error(`payload_too_large: ${name} is too long`);
  return value;
}

/**
 * What a plugin's tool sees as `vault.*`. Everything is checked here, on the server side of the
 * sandbox boundary: the manifest must declare a folder covering the path **and** the caller must
 * hold the permission there. Authorship is fixed here as well ({@link pluginAuthor}); the plugin
 * cannot pick who it acts as.
 */
export function createHostApi(ctx: Ctx, manifest: PluginManifest): HostFunctions {
  const { vaults, indexes, history, proposals } = ctx.deps;
  const vault = ctx.vault;
  const guard = readableIn(ctx);
  const author = pluginAuthor(manifest, ctx.author);

  const path = (raw: unknown, name = "path"): string => {
    try {
      return cleanPath(string(raw, name, 1024));
    } catch (err) {
      throw isAppError(err) ? new Error(`invalid_path: ${err.message}`) : err;
    }
  };
  const mayRead = (p: string) =>
    pluginMayAccess(manifest, "read", vault, p, ctx.access) && guard.can(p);
  const mayWrite = (p: string) => pluginMayAccess(manifest, "write", vault, p, ctx.access);

  const guarded =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: unknown) => {
      try {
        return await fn(args as A);
      } catch (err) {
        throw asPluginError(err);
      }
    };

  return {
    read: guarded(async (raw) => {
      const p = path(object(raw, "vault.read").path);
      if (!mayRead(p)) throw denied(`read ${p}`);
      const file = await vaults.readFile(vault, p);
      if (Buffer.byteLength(file.content) > MAX_HOST_TEXT_BYTES)
        throw new Error("payload_too_large: the file is too large to read from a plugin");
      return file.content;
    }),

    list: guarded(async (raw) => {
      const a = object(raw ?? {}, "vault.list");
      const dir = a.dir === undefined || a.dir === "" ? "" : path(a.dir, "dir");
      const prefix = dir === "" ? "" : `${dir}/`;
      const out: string[] = [];
      for (const file of await vaults.listFiles(vault)) {
        if (prefix !== "" && !file.startsWith(prefix)) continue;
        if (!mayRead(file)) continue;
        out.push(file);
        if (out.length >= MAX_LIST) break;
      }
      return out;
    }),

    search: guarded(async (raw) => {
      const a = object(raw, "vault.search");
      const q = string(a.q, "q", 500);
      if (q.trim() === "") throw new Error("invalid_argument: q must not be empty");
      const limit =
        typeof a.limit === "number" ? Math.min(Math.max(1, Math.floor(a.limit)), MAX_SEARCH) : 20;
      const page = await indexes.search.search(vault, q, {
        limit,
        offset: 0,
        include: mayRead,
        ...(typeof a.dir === "string" && a.dir !== "" ? { folder: path(a.dir, "dir") } : {}),
      });
      return page.hits.map((h) => ({
        path: h.path,
        ...(h.matches.length > 0 ? { matches: h.matches } : {}),
      }));
    }),

    write: guarded(async (raw) => {
      const a = object(raw, "vault.write");
      const p = path(a.path);
      const content = string(a.content, "content");
      if (!mayWrite(p)) throw denied(`write ${p}`);
      let last: unknown;
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        let base: string | null = null;
        try {
          base = (await vaults.readFile(vault, p, { fresh: attempt > 0 })).version;
        } catch (err) {
          if (!isAppError(err) || err.code !== "not_found") throw err;
        }
        try {
          const written = await vaults.writeFile(vault, p, content, {
            baseVersion: base,
            onWritten: (w) => history.record(vault, [w.path], author, ctx.note),
          });
          return { path: written.path, version: written.version };
        } catch (err) {
          if (!isAppError(err) || err.code !== "version_conflict") throw err;
          last = err;
        }
      }
      throw last;
    }),

    propose: guarded(async (raw) => {
      const a = object(raw, "vault.propose");
      const p = path(a.path);
      const content = string(a.content, "content");
      if (!mayWrite(p)) throw denied(`propose changes to ${p}`);
      if (!ctx.access.can("proposal.create", vaultScope(vault)))
        throw denied("create edit proposals");
      let current: { version: string; content: string } | null = null;
      try {
        current = await vaults.readFile(vault, p, { fresh: true });
      } catch (err) {
        if (!isAppError(err) || err.code !== "not_found") throw err;
      }
      const before = current?.content ?? "";
      if (before === content) throw new Error("invalid_argument: the content is unchanged");
      const title =
        typeof a.title === "string" && a.title.trim() !== ""
          ? string(a.title, "title", 200).trim()
          : `Change ${p}`;
      const proposal = await proposals.create(
        vault,
        {
          title,
          rationale: ctx.note.reason ?? "",
          sources: [],
          files: [
            {
              path: p,
              baseRevision: current?.version ?? null,
              hunks: [{ start: 0, end: before.length, before, after: content, rationale: "" }],
            },
          ],
        },
        author,
      );
      return { id: proposal.id, state: proposal.state };
    }),
  };
}
