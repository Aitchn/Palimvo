import { stat } from "node:fs/promises";
import { Hono } from "hono";
import { AppError, basename, isInside, normalizeVaultPath, type TreeNode } from "@palimvo/core";
import type { VaultService } from "../vault/service.ts";
import { zipStream, type ZipEntry } from "../zip.ts";

/** The folder named by `path`, or the whole tree for "". */
function findFolder(nodes: readonly TreeNode[], folder: string): readonly TreeNode[] | undefined {
  if (folder === "") return nodes;
  for (const node of nodes) {
    if (node.type !== "folder") continue;
    if (node.path === folder) return node.children ?? [];
    if (isInside(folder, node.path)) {
      const found = findFolder(node.children ?? [], folder);
      if (found) return found;
    }
  }
  return undefined;
}

/** `Content-Disposition` with an ASCII fallback and the real UTF-8 name. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** `GET /api/vaults/:vault/archive?path=<folder>`: a folder (or the whole vault) as a ZIP file. */
export function archiveRoutes(vaults: VaultService): Hono {
  const app = new Hono();

  app.get("/api/vaults/:vault/archive", async (c) => {
    const vault = c.req.param("vault");
    const raw = c.req.query("path") ?? "";
    let folder = "";
    if (raw !== "") {
      try {
        folder = normalizeVaultPath(raw);
      } catch {
        throw new AppError("invalid_path", undefined, { path: raw });
      }
    }
    const tree = await vaults.tree(vault);
    const nodes = findFolder(tree, folder);
    if (!nodes) throw new AppError("not_found", undefined, { path: folder });

    const root = folder === "" ? vault : basename(folder);
    const entries: ZipEntry[] = [{ name: `${root}/`, mtime: Date.now() }];
    const add = async (list: readonly TreeNode[], prefix: string): Promise<void> => {
      for (const node of list) {
        const name = `${prefix}${node.name}`;
        if (node.type === "folder") {
          entries.push({ name: `${name}/`, mtime: Date.now() });
          await add(node.children ?? [], `${name}/`);
        } else {
          const { abs } = await vaults.locateFile(vault, node.path);
          const info = await stat(abs).catch(() => null);
          // Removed since the tree was read: leave it out rather than fail the whole download.
          if (info?.isFile()) entries.push({ name, source: abs, mtime: info.mtimeMs });
        }
      }
    };
    await add(nodes, `${root}/`);

    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", attachment(`${root}.zip`));
    c.header("Cache-Control", "no-store");
    return c.body(ReadableStream.from(zipStream(entries)));
  });

  return app;
}
