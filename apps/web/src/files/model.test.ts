import type { TreeNode } from "@palimvo/core";
import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  findNode,
  flattenTree,
  listFiles,
  nameProblem,
  remapPath,
  tabTitle,
  uniqueName,
} from "./model.ts";

const tree: TreeNode[] = [
  {
    name: "Projects",
    path: "Projects",
    type: "folder",
    children: [
      { name: "Plan.md", path: "Projects/Plan.md", type: "file", kind: "markdown" },
      {
        name: "Old",
        path: "Projects/Old",
        type: "folder",
        children: [{ name: "a.md", path: "Projects/Old/a.md", type: "file", kind: "markdown" }],
      },
    ],
  },
  { name: "Welcome.md", path: "Welcome.md", type: "file", kind: "markdown" },
];

describe("flattenTree", () => {
  it("lists only the children of open folders, with depth and position", () => {
    expect(flattenTree(tree, new Set()).map((r) => r.node.path)).toEqual([
      "Projects",
      "Welcome.md",
    ]);
    const rows = flattenTree(tree, new Set(["Projects"]));
    expect(rows.map((r) => [r.node.path, r.depth, r.position, r.siblings, r.parent])).toEqual([
      ["Projects", 0, 1, 2, ""],
      ["Projects/Plan.md", 1, 1, 2, "Projects"],
      ["Projects/Old", 1, 2, 2, "Projects"],
      ["Welcome.md", 0, 2, 2, ""],
    ]);
  });

  it("does not show children of an open folder whose parent is closed", () => {
    const rows = flattenTree(tree, new Set(["Projects/Old"]));
    expect(rows.map((r) => r.node.path)).toEqual(["Projects", "Welcome.md"]);
  });
});

describe("tree helpers", () => {
  it("finds nodes ignoring letter case and lists files in tree order", () => {
    expect(findNode(tree, "projects/old/A.md")?.path).toBe("Projects/Old/a.md");
    expect(findNode(tree, "Nope.md")).toBeUndefined();
    expect(listFiles(tree)).toEqual(["Projects/Plan.md", "Projects/Old/a.md", "Welcome.md"]);
  });

  it("names the folders above a path", () => {
    expect(ancestorsOf("a/b/c.md")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("c.md")).toEqual([]);
  });

  it("follows a rename, move or delete", () => {
    expect(remapPath("a/b.md", "a", "x")).toBe("x/b.md");
    expect(remapPath("a/b.md", "a/b.md", "a/c.md")).toBe("a/c.md");
    expect(remapPath("ab/b.md", "a", "x")).toBe("ab/b.md");
    expect(remapPath("a/b.md", "a", null)).toBeNull();
    expect(remapPath("z.md", "a", null)).toBe("z.md");
  });

  it("titles tabs without .md", () => {
    expect(tabTitle("a/Plan.md")).toBe("Plan");
    expect(tabTitle("a/Board.canvas")).toBe("Board.canvas");
  });
});

describe("uniqueName", () => {
  it("numbers a taken name before its extension", () => {
    const taken = new Set(["Note.md", "Note 2.md"]);
    expect(uniqueName("Note.md", (n) => taken.has(n))).toBe("Note 3.md");
    expect(uniqueName("Fresh.md", (n) => taken.has(n))).toBe("Fresh.md");
    expect(uniqueName("Folder", (n) => n === "Folder")).toBe("Folder 2");
    expect(uniqueName(".env", (n) => n === ".env")).toBe(".env 2");
  });
});

describe("nameProblem", () => {
  it("accepts ordinary names, including other scripts", () => {
    for (const name of ["Plan.md", "日本語 ノート.md", "a b", "v1.2.md"]) {
      expect(nameProblem(name), name).toBeNull();
    }
  });

  it("rejects empty names, separators, Windows-reserved names and trailing dots", () => {
    expect(nameProblem("  ")).toBe("empty");
    for (const name of ["a/b", "a\\b", "a:b", "what?", "con", "end.", "..", ".git", ".palimvo"]) {
      expect(nameProblem(name), name).toBe("invalid");
    }
  });
});
