import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { basename, dirname, type TreeNode } from "@palimvo/core";
import { archiveUrl } from "../api/files.ts";
import { Palette, type PaletteItem } from "../commands/Palette.tsx";
import { rank } from "../commands/fuzzy.ts";
import { registerCommands, useCommands } from "../commands/registry.ts";
import { ConfirmDelete, NamePrompt } from "../files/FileDialogs.tsx";
import { ancestorsOf, findNode, listFiles, tabTitle } from "../files/model.ts";
import { useFileOperations } from "../files/useFileOperations.ts";
import { useVaultTree } from "../files/useVaultTree.ts";
import { Shell } from "../shell/Shell.tsx";
import { Tabs } from "../shell/Tabs.tsx";
import { Icon } from "../ui/index.ts";
import { fileHref, pathFromLocation, vaultHref } from "./deepLinks.ts";
import { FileView } from "./FileView.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useExpanded } from "./useExpanded.ts";
import { useTabs } from "./useTabs.ts";

/** `/v/:vault/*`: a vault's workspace. A new instance per vault, so tabs and open folders never mix. */
export function VaultPage() {
  const { vault = "" } = useParams();
  return <VaultWorkspace key={vault} vault={vault} />;
}

const NO_NODES: readonly TreeNode[] = [];

function folderOfPath(path: string | null): string {
  return path ? dirname(path) : "";
}

function VaultWorkspace({ vault }: { vault: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const params = useParams();
  const location = pathFromLocation(params["*"]);
  const tree = useVaultTree(vault);
  const nodes: readonly TreeNode[] = tree.status === "ready" ? tree.tree : NO_NODES;
  const tabs = useTabs(vault);
  const folders = useExpanded(vault);
  const [quickOpen, setQuickOpen] = useState(false);
  const [palette, setPalette] = useState(false);

  const target = tree.status === "ready" && location ? findNode(nodes, location) : undefined;
  const activeFile = target?.type === "file" ? target : null;
  const activePath = activeFile?.path ?? null;

  const openFile = useCallback(
    (path: string) => navigate(fileHref(vault, path)),
    [navigate, vault],
  );

  const operations = useFileOperations({
    vault,
    nodes,
    refresh: tree.refresh,
    reveal: folders.reveal,
    openFile,
    onPathChanged: (from, to) => {
      tabs.remap(from, to);
      folders.remap(from, to);
      const open = activePath ?? location;
      if (!open) return;
      if (to === null) {
        if (open === from || open.startsWith(`${from}/`)) {
          navigate(vaultHref(vault), { replace: true });
        }
      } else if (open === from || open.startsWith(`${from}/`)) {
        navigate(fileHref(vault, to + open.slice(from.length)), { replace: true });
      }
    },
  });

  // Opening an address (or a file from anywhere) shows it as a tab and reveals it in the tree.
  useEffect(() => {
    if (!target) return;
    if (target.type === "file") tabs.open(target.path);
    folders.reveal(
      target.type === "file"
        ? ancestorsOf(target.path)
        : [...ancestorsOf(target.path), target.path],
    );
    // Only a change of the target matters; `tabs` and `folders` are fresh objects every render.
  }, [target?.path, target?.type]);

  const closeTab = (path: string) => {
    const next = tabs.close(path);
    if (path === activePath) navigate(next ? fileHref(vault, next) : vaultHref(vault));
  };

  // ---- quick open and commands ----------------------------------------------------------

  const files = useMemo(() => listFiles(nodes), [nodes]);
  const searchFiles = useCallback(
    (query: string): PaletteItem[] => {
      // With nothing typed: the open tabs first, then everything else.
      const ordered =
        query.trim() === ""
          ? [
              ...tabs.tabs.filter((p) => files.includes(p)),
              ...files.filter((p) => !tabs.tabs.includes(p)),
            ]
          : files;
      return rank(query, ordered, (p) => p).map((path) => ({
        id: path,
        title: tabTitle(path),
        detail: dirname(path) || undefined,
        icon: "note",
      }));
    },
    [files, tabs.tabs],
  );

  const commands = useCommands();
  const searchCommands = useCallback(
    (query: string): PaletteItem[] =>
      rank(query, commands, (c) => c.title).map((c) => ({
        id: c.id,
        title: c.title,
        hint: c.hint,
        icon: c.icon,
      })),
    [commands],
  );

  useEffect(
    () =>
      registerCommands([
        {
          id: "file.newNote",
          title: t("files.newNote"),
          icon: "add",
          run: () => operations.openPrompt({ kind: "note", folder: folderOfPath(activePath) }),
        },
        {
          id: "file.newFolder",
          title: t("files.newFolder"),
          icon: "folderAdd",
          run: () => operations.openPrompt({ kind: "folder", folder: folderOfPath(activePath) }),
        },
        {
          id: "file.quickOpen",
          title: t("quickOpen.title"),
          icon: "search",
          hint: "Ctrl+P",
          run: () => setQuickOpen(true),
        },
        {
          id: "file.downloadVault",
          title: t("files.downloadVaultZip"),
          icon: "download",
          run: () => window.location.assign(archiveUrl(vault, "")),
        },
        {
          id: "nav.vaults",
          title: t("workspace.allVaults"),
          icon: "files",
          run: () => navigate("/"),
        },
        ...(activeFile
          ? [
              {
                id: "file.rename",
                title: t("files.rename"),
                icon: "edit" as const,
                hint: "F2",
                run: () => operations.openPrompt({ kind: "rename", node: activeFile }),
              },
              {
                id: "file.delete",
                title: t("common.delete"),
                icon: "trash" as const,
                run: () => operations.askDelete(activeFile),
              },
              {
                id: "file.close",
                title: t("workspace.closeTab"),
                icon: "close" as const,
                run: () => closeTab(activeFile.path),
              },
            ]
          : []),
      ]),
    // The commands close over the latest handlers; re-register when what they act on changes.
    [t, i18n.language, vault, activePath, nodes],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey || event.key.toLowerCase() !== "p") return;
      event.preventDefault(); // the browser's print dialog
      if (event.shiftKey) {
        setQuickOpen(false);
        setPalette(true);
      } else {
        setPalette(false);
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runCommand = (id: string) => commands.find((c) => c.id === id)?.run();

  const missing = tree.status === "ready" && location !== "" && !target;

  return (
    <>
      <Shell
        sidebar={
          <Sidebar
            vault={vault}
            tree={tree}
            expanded={folders.expanded}
            activePath={activePath}
            operations={operations}
            onToggle={folders.toggle}
            onOpen={openFile}
            onQuickOpen={() => setQuickOpen(true)}
            onCommands={() => setPalette(true)}
          />
        }
        tabs={
          <Tabs
            tabs={tabs.tabs.map((path) => ({ id: path, title: tabTitle(path), detail: path }))}
            activeId={activePath}
            onSelect={openFile}
            onClose={closeTab}
          />
        }
        inspector={
          <div className="state">
            {activeFile ? (
              <dl className="details">
                <dt>{t("workspace.detailsName")}</dt>
                <dd>{basename(activeFile.path)}</dd>
                <dt>{t("workspace.detailsPath")}</dt>
                <dd>{activeFile.path}</dd>
              </dl>
            ) : (
              <p className="muted">{t("shell.inspectorEmpty")}</p>
            )}
          </div>
        }
      >
        {activeFile ? (
          <FileView
            key={activeFile.path}
            vault={vault}
            path={activeFile.path}
            kind={activeFile.kind ?? "other"}
          />
        ) : (
          <div className="state">
            <Icon name={missing ? "warning" : "note"} />
            <h1>{missing ? t("workspace.notFoundTitle") : t("shell.noFileTitle")}</h1>
            <p className="muted">
              {missing ? t("workspace.notFoundBody", { path: location }) : t("shell.noFileBody")}
            </p>
          </div>
        )}
      </Shell>
      <Palette
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        title={t("quickOpen.title")}
        placeholder={t("quickOpen.placeholder")}
        emptyText={t("quickOpen.empty")}
        search={searchFiles}
        onChoose={openFile}
      />
      <Palette
        open={palette}
        onClose={() => setPalette(false)}
        title={t("commands.title")}
        placeholder={t("commands.placeholder")}
        emptyText={t("commands.empty")}
        search={searchCommands}
        onChoose={runCommand}
      />
      <NamePrompt
        open={operations.prompt !== null}
        title={
          operations.prompt?.kind === "note"
            ? t("files.newNote")
            : operations.prompt?.kind === "folder"
              ? t("files.newFolder")
              : t("files.rename")
        }
        folder={
          operations.prompt?.kind === "rename"
            ? dirname(operations.prompt.node.path)
            : (operations.prompt?.folder ?? "")
        }
        initial={
          operations.prompt?.kind === "rename"
            ? operations.prompt.node.name
            : operations.prompt?.kind === "note"
              ? t("files.untitled")
              : ""
        }
        submitLabel={operations.prompt?.kind === "rename" ? t("files.rename") : t("files.create")}
        onClose={operations.closePrompt}
        onSubmit={operations.submitPrompt}
      />
      <ConfirmDelete
        open={operations.confirmDelete !== null}
        name={operations.confirmDelete?.name ?? ""}
        isFolder={operations.confirmDelete?.type === "folder"}
        onClose={operations.cancelDelete}
        onConfirm={operations.confirmDeleteNow}
      />
    </>
  );
}
