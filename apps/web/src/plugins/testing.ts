import { parseManifest, type PluginManifestInput } from "@palimvo/plugin-sdk";
import type { TreeNode } from "@palimvo/core";
import type { VaultBackend } from "./bridge.ts";
import type { LoadedPlugin } from "./frame.ts";

/** A runnable plugin for tests: a valid manifest with the given overrides. */
export function makePlugin(
  input: Partial<PluginManifestInput> & { id: string },
  extra: { code?: string; hash?: string; locales?: LoadedPlugin["locales"] } = {},
): LoadedPlugin {
  const manifest = parseManifest({
    manifestVersion: 2,
    version: "1.0.0",
    name: { en: input.id },
    ...input,
  });
  return {
    manifest,
    hash: extra.hash ?? "a".repeat(64),
    code: extra.code ?? "export default () => {};",
    locales: extra.locales ?? {},
  };
}

export const TREE: TreeNode[] = [
  {
    name: "decisions",
    path: "decisions",
    type: "folder",
    children: [
      { name: "0001-a.md", path: "decisions/0001-a.md", type: "file", kind: "markdown" },
      {
        name: "old",
        path: "decisions/old",
        type: "folder",
        children: [
          { name: "0000.md", path: "decisions/old/0000.md", type: "file", kind: "markdown" },
        ],
      },
    ],
  },
  {
    name: "private",
    path: "private",
    type: "folder",
    children: [{ name: "diary.md", path: "private/diary.md", type: "file", kind: "markdown" }],
  },
  { name: "Welcome.md", path: "Welcome.md", type: "file", kind: "markdown" },
];

/** A vault backend that records what reached it. */
export function fakeBackend(): VaultBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(path) {
      calls.push(`read ${path}`);
      return `text of ${path}`;
    },
    async readBinary(path) {
      calls.push(`readBinary ${path}`);
      return new Uint8Array([1, 2, 3]);
    },
    async tree() {
      calls.push("tree");
      return TREE;
    },
    async search(query, options) {
      calls.push(`search ${query}`);
      void options;
      return [
        { path: "decisions/0001-a.md", title: "0001-a" },
        { path: "private/diary.md", title: "diary" },
        { path: "Welcome.md", title: "Welcome" },
      ];
    },
    async queryBase(path) {
      calls.push(`queryBase ${path}`);
      return {
        columns: ["path", "status"],
        rows: [
          { path: "decisions/0001-a.md", status: "ok" },
          { path: "private/diary.md", status: "secret" },
        ],
      };
    },
    async write(path, content, reason) {
      calls.push(`write ${path} ${content} ${reason ?? ""}`);
      return { revision: "r1" };
    },
    async propose(input) {
      calls.push(`propose ${input.path}`);
      return { proposalId: "p1" };
    },
  };
}
