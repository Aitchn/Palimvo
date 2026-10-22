import type { TreeNode } from "@palimvo/core";

/** True if any part of a path is hidden (starts with a dot), e.g. `.palimvo/config.json`. */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((s) => s.startsWith("."));
}

/** What guests may read in one vault; `entries` are normalized paths, `""` meaning everything. */
export class PublicPolicy {
  constructor(readonly entries: readonly string[]) {}

  get any(): boolean {
    return this.entries.length > 0;
  }

  /**
   * A file or folder is public if it is listed or lies inside a public folder (or the vault is
   * public). Names are compared exactly: on a case-sensitive disk `Public.md` and `public.md` are
   * different files, and publishing one must not publish the other.
   */
  covers(path: string): boolean {
    if (isHiddenPath(path)) return false;
    return this.entries.some((e) => e === "" || path === e || path.startsWith(`${e}/`));
  }

  /** The tree guests see: public entries plus the folders needed to reach them. */
  filterTree(nodes: readonly TreeNode[]): TreeNode[] {
    const out: TreeNode[] = [];
    for (const node of nodes) {
      if (this.covers(node.path)) {
        out.push(node);
      } else if (node.type === "folder" && !isHiddenPath(node.path)) {
        const children = this.filterTree(node.children ?? []);
        if (children.length > 0) out.push({ ...node, children });
      }
    }
    return out;
  }
}
