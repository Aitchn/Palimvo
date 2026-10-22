import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TreeNode } from "@palimvo/core";
import { archiveUrl } from "../api/files.ts";
import { describeError } from "../api/errors.ts";
import { FileTree, type RowMenuRequest } from "../files/FileTree.tsx";
import type { useFileOperations } from "../files/useFileOperations.ts";
import { Button, ContextMenu, Skeleton, type MenuItem } from "../ui/index.ts";
import type { TreeState } from "../files/useVaultTree.ts";
import { VaultSwitcher } from "./VaultSwitcher.tsx";

type Operations = ReturnType<typeof useFileOperations>;

interface Props {
  vault: string;
  tree: TreeState & { reload: () => void };
  expanded: ReadonlySet<string>;
  activePath: string | null;
  operations: Operations;
  onToggle: (folder: string) => void;
  onOpen: (path: string) => void;
  onQuickOpen: () => void;
  onCommands: () => void;
}

/** Starts the browser's download of a folder (or the whole vault) as a ZIP. */
function download(vault: string, folder: string) {
  const link = document.createElement("a");
  link.href = archiveUrl(vault, folder);
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

/** Left panel of a vault: switcher, toolbar and the file tree with its context menus. */
export function Sidebar({
  vault,
  tree,
  expanded,
  activePath,
  operations,
  onToggle,
  onOpen,
  onQuickOpen,
  onCommands,
}: Props) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<RowMenuRequest | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const importInto = useRef("");

  const pickFilesFor = (folder: string) => {
    importInto.current = folder;
    picker.current?.click();
  };

  const itemsFor = (node: TreeNode | null): MenuItem[] => {
    if (node === null) {
      return [
        {
          id: "note",
          label: t("files.newNote"),
          icon: "add",
          onSelect: () => operations.openPrompt({ kind: "note", folder: "" }),
        },
        {
          id: "folder",
          label: t("files.newFolder"),
          icon: "folderAdd",
          onSelect: () => operations.openPrompt({ kind: "folder", folder: "" }),
        },
        {
          id: "import",
          label: t("files.import"),
          icon: "upload",
          onSelect: () => pickFilesFor(""),
        },
        {
          id: "zip",
          label: t("files.downloadVaultZip"),
          icon: "download",
          onSelect: () => download(vault, ""),
        },
      ];
    }
    const rename: MenuItem = {
      id: "rename",
      label: t("files.rename"),
      icon: "edit",
      onSelect: () => operations.openPrompt({ kind: "rename", node }),
    };
    const remove: MenuItem = {
      id: "delete",
      label: t("common.delete"),
      icon: "trash",
      danger: true,
      onSelect: () => operations.askDelete(node),
    };
    if (node.type === "file") {
      return [
        { id: "open", label: t("files.open"), icon: "note", onSelect: () => onOpen(node.path) },
        rename,
        remove,
      ];
    }
    return [
      {
        id: "note",
        label: t("files.newNote"),
        icon: "add",
        onSelect: () => operations.openPrompt({ kind: "note", folder: node.path }),
      },
      {
        id: "folder",
        label: t("files.newFolder"),
        icon: "folderAdd",
        onSelect: () => operations.openPrompt({ kind: "folder", folder: node.path }),
      },
      {
        id: "import",
        label: t("files.import"),
        icon: "upload",
        onSelect: () => pickFilesFor(node.path),
      },
      rename,
      {
        id: "zip",
        label: t("files.downloadZip"),
        icon: "download",
        onSelect: () => download(vault, node.path),
      },
      remove,
    ];
  };

  /** New items go into the folder of the open file, else the root. */
  const here =
    activePath && activePath.includes("/") ? activePath.split("/").slice(0, -1).join("/") : "";

  return (
    <>
      <div className="sidebar-header">
        <VaultSwitcher vault={vault} />
      </div>
      <div className="sidebar-toolbar" role="toolbar" aria-label={t("files.toolbar")}>
        <Button
          variant="ghost"
          icon="add"
          aria-label={t("files.newNote")}
          title={t("files.newNote")}
          onClick={() => operations.openPrompt({ kind: "note", folder: here })}
        />
        <Button
          variant="ghost"
          icon="folderAdd"
          aria-label={t("files.newFolder")}
          title={t("files.newFolder")}
          onClick={() => operations.openPrompt({ kind: "folder", folder: here })}
        />
        <Button
          variant="ghost"
          icon="upload"
          aria-label={t("files.import")}
          title={t("files.import")}
          onClick={() => pickFilesFor(here)}
        />
        <span className="toolbar-spacer" />
        <Button
          variant="ghost"
          icon="search"
          aria-label={t("quickOpen.open")}
          title={`${t("quickOpen.open")} (Ctrl+P)`}
          onClick={onQuickOpen}
        />
        <Button
          variant="ghost"
          icon="command"
          aria-label={t("commands.open")}
          title={`${t("commands.open")} (Ctrl+Shift+P)`}
          onClick={onCommands}
        />
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        data-testid="import-input"
        onChange={(event) => {
          void operations.pickFiles(event.target.files, importInto.current);
          event.target.value = "";
        }}
      />
      <div className="sidebar-body tree-body">
        {tree.status === "loading" && <Skeleton lines={5} />}
        {tree.status === "error" && (
          <div className="state" role="alert">
            <p>{describeError(t, tree.error)}</p>
            <Button onClick={tree.reload}>{t("common.retry")}</Button>
          </div>
        )}
        {tree.status === "ready" && (
          <FileTree
            nodes={tree.tree}
            expanded={expanded}
            activePath={activePath}
            onToggle={onToggle}
            onOpen={(file) => onOpen(file.path)}
            onMenu={setMenu}
            onRename={(node) => operations.openPrompt({ kind: "rename", node })}
            onDelete={operations.askDelete}
            onMove={(from, into) => void operations.move(from, into)}
            onDropFiles={(data, into) => void operations.dropFiles(data, into)}
          />
        )}
      </div>
      {menu && (
        <ContextMenu
          label={menu.node ? menu.node.name : t("files.tree")}
          items={itemsFor(menu.node)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
