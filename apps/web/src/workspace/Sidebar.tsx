import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TreeNode } from "@palimvo/core";
import { archiveUrl } from "../api/files.ts";
import { describeError } from "../api/errors.ts";
import { FolderPermissionsDialog } from "../roles/FolderPermissionsDialog.tsx";
import { FileTree, type RowMenuRequest } from "../files/FileTree.tsx";
import type { useFileOperations } from "../files/useFileOperations.ts";
import { listProposals } from "../api/proposals.ts";
import { useAsync } from "../app/useAsync.ts";
import { ChangeLog } from "../history/ChangeLog.tsx";
import { ProposalsPanel } from "../proposals/ProposalsPanel.tsx";
import { SearchPanel } from "../search/SearchPanel.tsx";
import { Button, ContextMenu, isIconName, Skeleton, type MenuItem } from "../ui/index.ts";
import type { TreeState } from "../files/useVaultTree.ts";
import { PluginAppLinks, PluginViewLinks, type PluginViewRef } from "../plugins/PluginViews.tsx";
import { useSlotItems } from "../plugins/slots.ts";
import { VaultSwitcher } from "./VaultSwitcher.tsx";
import type { VaultCan } from "./useVaultPermissions.ts";

type Operations = ReturnType<typeof useFileOperations>;

export type SidebarView = "files" | "search" | "history" | "proposals";

interface Props {
  vault: string;
  tree: TreeState & { reload: () => void };
  expanded: ReadonlySet<string>;
  activePath: string | null;
  operations: Operations;
  /** What the signed-in person may change; the rest is not offered. */
  can: VaultCan;
  onToggle: (folder: string) => void;
  onOpen: (path: string) => void;
  onQuickOpen: () => void;
  onHome: () => void;
  onCommands: () => void;
  /** The plugin page open in the main area, if any. */
  pluginView: PluginViewRef | null;
  onOpenPluginView: (ref: PluginViewRef) => void;
  /** The plugin application open in the main area, if any. */
  pluginApp: string | null;
  onOpenPluginApp: (plugin: string) => void;
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  /** Changes whenever the search box should take focus. */
  searchFocus: number;
  /** Changes when the vault's files changed, so the change log is fetched again. */
  revision: number;
}

const VIEW_LABELS = {
  files: "search.files",
  search: "search.title",
  history: "history.title",
  proposals: "proposals.title",
} as const;

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
  can,
  onToggle,
  onOpen,
  onQuickOpen,
  onHome,
  onCommands,
  pluginView,
  onOpenPluginView,
  pluginApp,
  onOpenPluginApp,
  view,
  onViewChange,
  searchFocus,
  revision,
}: Props) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<RowMenuRequest | null>(null);
  const [permissionsOf, setPermissionsOf] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Plugin entries are asked about only while a menu is open, for the row it was opened on.
  const pluginMenuItems = useSlotItems(
    "context-menu",
    menu ? { path: menu.node?.path ?? null } : null,
  );
  const importInto = useRef("");
  const [query, setQuery] = useState("");
  const [allProposals, setAllProposals] = useState(false);
  // Fetched even while another view is shown, so the tab can say how many are waiting.
  const proposals = useAsync(
    (signal) =>
      can.propose ? listProposals(vault, { all: allProposals, signal }) : Promise.resolve([]),
    `proposals:${vault}:${allProposals}:${revision}:${can.propose}`,
  );
  const waiting =
    proposals.status === "ready"
      ? proposals.data.filter((p) => p.state === "pending" || p.state === "partial").length
      : 0;

  const pickFilesFor = (folder: string) => {
    importInto.current = folder;
    picker.current?.click();
  };

  const itemsFor = (node: TreeNode | null): MenuItem[] => {
    if (node === null) {
      return [
        ...(can.write
          ? [
              {
                id: "note",
                label: t("files.newNote"),
                icon: "add" as const,
                onSelect: () => operations.openPrompt({ kind: "note", folder: "" }),
              },
              {
                id: "folder",
                label: t("files.newFolder"),
                icon: "folderAdd" as const,
                onSelect: () => operations.openPrompt({ kind: "folder", folder: "" }),
              },
            ]
          : []),
        ...(can.upload
          ? [
              {
                id: "import",
                label: t("files.import"),
                icon: "upload" as const,
                onSelect: () => pickFilesFor(""),
              },
            ]
          : []),
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
    const editing = [...(can.write && can.delete ? [rename] : []), ...(can.delete ? [remove] : [])];
    if (node.type === "file") {
      return [
        { id: "open", label: t("files.open"), icon: "note", onSelect: () => onOpen(node.path) },
        ...editing,
      ];
    }
    return [
      ...(can.write
        ? [
            {
              id: "note",
              label: t("files.newNote"),
              icon: "add" as const,
              onSelect: () => operations.openPrompt({ kind: "note", folder: node.path }),
            },
            {
              id: "folder",
              label: t("files.newFolder"),
              icon: "folderAdd" as const,
              onSelect: () => operations.openPrompt({ kind: "folder", folder: node.path }),
            },
          ]
        : []),
      ...(can.upload
        ? [
            {
              id: "import",
              label: t("files.import"),
              icon: "upload" as const,
              onSelect: () => pickFilesFor(node.path),
            },
          ]
        : []),
      ...(can.write && can.delete ? [rename] : []),
      {
        id: "zip",
        label: t("files.downloadZip"),
        icon: "download",
        onSelect: () => download(vault, node.path),
      },
      ...(can.managePermissions
        ? [
            {
              id: "permissions",
              label: t("permissions.menu"),
              icon: "settings" as const,
              onSelect: () => setPermissionsOf(node.path),
            },
          ]
        : []),
      ...(can.delete ? [remove] : []),
    ];
  };

  /** New items go into the folder of the open file, else the root. */
  const here =
    activePath && activePath.includes("/") ? activePath.split("/").slice(0, -1).join("/") : "";

  return (
    <>
      <div className="sidebar-header">
        <VaultSwitcher vault={vault} />
        <Button
          variant="ghost"
          icon="home"
          aria-label={t("home.open")}
          title={t("home.open")}
          onClick={onHome}
        />
      </div>
      <div className="sidebar-views" role="group" aria-label={t("search.viewLabel")}>
        {(
          [
            "files",
            "search",
            ...(can.viewHistory ? (["history"] as const) : []),
            ...(can.propose ? (["proposals"] as const) : []),
          ] as const
        ).map((id) => (
          <button
            key={id}
            type="button"
            className="sidebar-view"
            aria-pressed={view === id}
            onClick={() => onViewChange(id)}
          >
            {t(VIEW_LABELS[id])}
            {id === "proposals" && waiting > 0 && (
              <span
                className="sidebar-badge"
                aria-label={t("proposals.waitingBadge", { count: waiting })}
              >
                {waiting}
              </span>
            )}
          </button>
        ))}
      </div>
      {view === "proposals" && can.propose ? (
        <ProposalsPanel
          vault={vault}
          proposals={proposals}
          showAll={allProposals}
          onShowAll={setAllProposals}
          canReview={can.review}
          onChanged={tree.reload}
          onOpenFile={onOpen}
        />
      ) : view === "history" && can.viewHistory ? (
        <ChangeLog
          vault={vault}
          revision={revision}
          canCheckpoint={can.checkpoint}
          onOpenFile={onOpen}
        />
      ) : view === "search" ? (
        <SearchPanel
          vault={vault}
          query={query}
          onQueryChange={setQuery}
          focusRequest={searchFocus}
          activePath={activePath}
          onOpen={onOpen}
        />
      ) : (
        <>
          <div className="sidebar-toolbar" role="toolbar" aria-label={t("files.toolbar")}>
            {can.write && (
              <>
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
              </>
            )}
            {can.upload && (
              <Button
                variant="ghost"
                icon="upload"
                aria-label={t("files.import")}
                title={t("files.import")}
                onClick={() => pickFilesFor(here)}
              />
            )}
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
                onRename={(node) => {
                  if (can.write && can.delete) operations.openPrompt({ kind: "rename", node });
                }}
                onDelete={(node) => {
                  if (can.delete) operations.askDelete(node);
                }}
                onMove={(from, into) => {
                  if (can.write && can.delete) void operations.move(from, into);
                }}
                onDropFiles={(data, into) => {
                  if (can.upload) void operations.dropFiles(data, into);
                }}
              />
            )}
          </div>
          <PluginViewLinks active={pluginView} onOpen={onOpenPluginView} />
          <PluginAppLinks active={pluginApp} onOpen={onOpenPluginApp} />
        </>
      )}
      <FolderPermissionsDialog
        vault={vault}
        folder={permissionsOf}
        onClose={() => setPermissionsOf(null)}
      />
      {menu && (
        <ContextMenu
          label={menu.node ? menu.node.name : t("files.tree")}
          items={[
            ...itemsFor(menu.node),
            ...pluginMenuItems.map((item): MenuItem => ({
              id: `plugin:${item.key}`,
              label: item.title,
              ...(isIconName(item.icon) ? { icon: item.icon } : {}),
              onSelect: () => void item.run(),
            })),
          ]}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
