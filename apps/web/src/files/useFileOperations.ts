import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { basename, dirname, joinPath, pathKey, type TreeNode } from "@palimvo/core";
import { ApiError, describeError } from "../api/errors.ts";
import { createFolder, deleteFile, moveFile, writeFile } from "../api/files.ts";
import { useToast } from "../ui/index.ts";
import { collectDropped, importItems, type ImportItem } from "./dropImport.ts";
import { ancestorsOf, findNode } from "./model.ts";

export type Prompt =
  | { kind: "note"; folder: string }
  | { kind: "folder"; folder: string }
  | { kind: "rename"; node: TreeNode };

interface Options {
  vault: string;
  nodes: readonly TreeNode[];
  /** Fetch the tree now. */
  refresh: () => Promise<void>;
  /** Folders to show open (after something was created or moved into them). */
  reveal: (folders: string[]) => void;
  /** `from` was renamed or moved to `to`, or deleted when `to` is `null`. */
  onPathChanged: (from: string, to: string | null) => void;
  openFile: (path: string) => void;
}

/** A note without an extension is a Markdown note. */
export function withExtension(name: string): string {
  // Only the last segment counts: `projects.v2/Plan` is still a note.
  return (name.split("/").pop() ?? name).includes(".") ? name : `${name}.md`;
}

/**
 * Everything the file tree can do to a vault, with the dialogs it needs (`prompt`,
 * `confirmDelete`) and the messages it shows. Failures from dialogs are thrown back to the
 * dialog; the rest become toasts.
 */
export function useFileOperations({
  vault,
  nodes,
  refresh,
  reveal,
  onPathChanged,
  openFile,
}: Options) {
  const { t } = useTranslation();
  const toast = useToast();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TreeNode | null>(null);

  const taken = useMemo(() => {
    const keys = new Set<string>();
    const visit = (list: readonly TreeNode[]) => {
      for (const node of list) {
        keys.add(pathKey(node.path));
        if (node.children) visit(node.children);
      }
    };
    visit(nodes);
    return (path: string) => keys.has(pathKey(path));
  }, [nodes]);

  const fail = useCallback(
    (error: unknown) => toast.push({ message: describeError(t, error), kind: "error" }),
    [t, toast],
  );

  const createNote = async (folder: string, name: string) => {
    const path = joinPath(folder, withExtension(name));
    if (taken(path)) throw new ApiError("already_exists", 409, "exists");
    await writeFile(vault, path, "", null);
    reveal(ancestorsOf(path));
    await refresh();
    openFile(path);
  };

  /** A [[link]] to a note that does not exist: make it at the top of the vault and open it. */
  const createLinked = async (target: string) => {
    const path = withExtension(target.trim());
    try {
      if (!taken(path)) await writeFile(vault, path, "", null);
      await refresh();
      openFile(path);
    } catch (error) {
      fail(error);
    }
  };

  const makeFolder = async (folder: string, name: string) => {
    const path = joinPath(folder, name);
    if (taken(path)) throw new ApiError("already_exists", 409, "exists");
    await createFolder(vault, path);
    reveal([...ancestorsOf(path), path]);
    await refresh();
  };

  const rename = async (node: TreeNode, name: string) => {
    const target = joinPath(dirname(node.path), name);
    if (target === node.path) return;
    // A change of letter case alone is the same file on Windows and macOS; the server decides.
    if (pathKey(target) !== pathKey(node.path) && taken(target)) {
      throw new ApiError("already_exists", 409, "exists");
    }
    await moveFile(vault, node.path, target);
    onPathChanged(node.path, target);
    await refresh();
  };

  const remove = async (node: TreeNode) => {
    await deleteFile(vault, node.path);
    onPathChanged(node.path, null);
    await refresh();
    toast.push({ message: t("files.deleted", { name: node.name }), kind: "success" });
  };

  const move = async (from: string, intoFolder: string) => {
    const target = joinPath(intoFolder, basename(from));
    if (target === from) return;
    if (taken(target)) {
      toast.push({ message: t("errors.already_exists"), kind: "error" });
      return;
    }
    try {
      await moveFile(vault, from, target);
      onPathChanged(from, target);
      reveal(ancestorsOf(target));
      await refresh();
    } catch (error) {
      fail(error);
    }
  };

  const importItemsInto = async (folder: string, items: ImportItem[]) => {
    if (items.length === 0) return;
    const result = await importItems(vault, folder, items, taken, {
      describe: (error) => describeError(t, error),
    });
    reveal(ancestorsOf(joinPath(folder, "x")));
    await refresh();
    if (result.imported.length > 0) {
      toast.push({
        message: t("files.imported", { count: result.imported.length }),
        kind: "success",
      });
    }
    if (result.skipped > 0) {
      toast.push({ message: t("files.importSkipped", { count: result.skipped }), kind: "info" });
    }
    if (result.failed > 0) {
      toast.push({ message: t("files.importFailed", { count: result.failed }), kind: "error" });
    }
  };

  const dropFiles = async (data: DataTransfer, folder: string) => {
    try {
      await importItemsInto(folder, await collectDropped(data));
    } catch (error) {
      fail(error);
    }
  };

  const pickFiles = async (files: FileList | null, folder: string) => {
    if (!files) return;
    try {
      await importItemsInto(
        folder,
        Array.from(files).map((file) => ({ path: file.name, file })),
      );
    } catch (error) {
      fail(error);
    }
  };

  /** What the open prompt does with the name typed into it. */
  const submitPrompt = async (name: string) => {
    if (!prompt) return;
    if (prompt.kind === "note") await createNote(prompt.folder, name);
    else if (prompt.kind === "folder") await makeFolder(prompt.folder, name);
    else await rename(prompt.node, name);
    setPrompt(null);
  };

  return {
    prompt,
    openPrompt: setPrompt,
    closePrompt: () => setPrompt(null),
    submitPrompt,
    confirmDelete,
    askDelete: setConfirmDelete,
    cancelDelete: () => setConfirmDelete(null),
    confirmDeleteNow: async () => {
      if (!confirmDelete) return;
      await remove(confirmDelete);
      setConfirmDelete(null);
    },
    move,
    createLinked,
    dropFiles,
    pickFiles,
    exists: (path: string) => findNode(nodes, path) !== undefined,
  };
}
