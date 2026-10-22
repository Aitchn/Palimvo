import {
  InvalidPathError,
  basename,
  dirname,
  isInside,
  joinPath,
  normalizeVaultPath,
  pathKey,
  type TreeNode,
} from "@palimvo/core";

/** One visible line of the tree. */
export interface Row {
  node: TreeNode;
  depth: number;
  /** 1-based position among its siblings, for assistive technology. */
  position: number;
  siblings: number;
  /** Path of the folder it is in ("" for the root). */
  parent: string;
}

/** The rows to draw: folders in `expanded` show their children. */
export function flattenTree(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const visit = (list: readonly TreeNode[], depth: number, parent: string) => {
    list.forEach((node, index) => {
      rows.push({ node, depth, position: index + 1, siblings: list.length, parent });
      if (node.type === "folder" && node.children && expanded.has(node.path)) {
        visit(node.children, depth + 1, node.path);
      }
    });
  };
  visit(nodes, 0, "");
  return rows;
}

export function findNode(nodes: readonly TreeNode[], path: string): TreeNode | undefined {
  const key = pathKey(path);
  for (const node of nodes) {
    if (pathKey(node.path) === key) return node;
    if (node.type === "folder" && node.children && isInside(path, node.path)) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

/** Every file path in the tree, in tree order. */
export function listFiles(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  const visit = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (node.type === "file") out.push(node.path);
      else if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

/** Folders above `path`, outermost first (`a/b/c.md` → `a`, `a/b`). */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * Where `path` ends up after `from` was renamed or moved to `to`; `null` when `to` is `null`
 * and `path` was `from` or inside it (it is gone).
 */
export function remapPath(path: string, from: string, to: string | null): string | null {
  if (!isInside(path, from)) return path;
  if (to === null) return null;
  return joinPath(to, path.slice(from.length).replace(/^\//, ""));
}

/** `Note.md` → `Note 2.md` → `Note 3.md`: the first name not in `taken` (compared like the file system does). */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} ${Date.now()}${ext}`;
}

/** Why a single file or folder name cannot be used, or `null` when it can. */
export function nameProblem(name: string): "empty" | "invalid" | null {
  if (name.trim() === "") return "empty";
  if (/[\\/]/.test(name)) return "invalid";
  try {
    return normalizeVaultPath(name) === name ? null : "invalid";
  } catch (error) {
    if (error instanceof InvalidPathError) return "invalid";
    throw error;
  }
}

/** The name to show in a tab: the file name without `.md`. */
export function tabTitle(path: string): string {
  return basename(path).replace(/\.md$/i, "");
}

export { basename, dirname, joinPath };
