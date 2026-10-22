import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { isInside, type TreeNode } from "@palimvo/core";
import { MOBILE_QUERY, useMediaQuery } from "../shell/layout.ts";
import { Icon, type IconName } from "../ui/index.ts";
import { flattenTree, type Row } from "./model.ts";

/** Row heights match `.tree-row` in files.css (taller on a phone, for fingers). */
const ROW_DESKTOP = 30;
const ROW_MOBILE = 40;
const OVERSCAN = 8;
/** What jsdom and a not yet laid out container report as height. */
const FALLBACK_HEIGHT = 800;

export const DRAG_TYPE = "application/x-palimvo-path";

export interface RowMenuRequest {
  /** `null`: the empty area below the rows (the vault root). */
  node: TreeNode | null;
  x: number;
  y: number;
}

interface Props {
  nodes: readonly TreeNode[];
  expanded: ReadonlySet<string>;
  /** Path of the file open in the main area. */
  activePath: string | null;
  onToggle: (folder: string) => void;
  onOpen: (file: TreeNode) => void;
  onMenu: (request: RowMenuRequest) => void;
  onRename: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
  /** An item of the tree was dropped on a folder ("" = root). */
  onMove: (from: string, intoFolder: string) => void;
  /** Files from outside the page were dropped on a folder ("" = root). */
  onDropFiles: (data: DataTransfer, intoFolder: string) => void;
}

function iconFor(node: TreeNode): IconName {
  if (node.type === "folder") return "files";
  return node.kind === "canvas" ? "canvas" : node.kind === "base" ? "base" : "note";
}

const rowId = (index: number) => `tree-row-${index}`;

/**
 * The vault's folders and files as an ARIA tree. Only the rows near the viewport are in the DOM,
 * so a vault with tens of thousands of files scrolls as smoothly as one with ten. Rows can be
 * dragged onto folders to move them; files dragged in from the desktop are imported.
 */
export function FileTree({
  nodes,
  expanded,
  activePath,
  onToggle,
  onOpen,
  onMenu,
  onRename,
  onDelete,
  onMove,
  onDropFiles,
}: Props) {
  const { t } = useTranslation();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const rowHeight = isMobile ? ROW_MOBILE : ROW_DESKTOP;
  const rows = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    setHeight(box.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(box.clientHeight));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const indexOfPath = (path: string | null) =>
    path === null ? -1 : rows.findIndex((row) => row.node.path === path);
  // The keyboard cursor: the focused row, else the open file, else the first row.
  const cursor = Math.max(
    0,
    indexOfPath(focused) >= 0 ? indexOfPath(focused) : indexOfPath(activePath),
  );

  // Keep the cursor on screen when it moves by keyboard.
  const scrollTo = (index: number) => {
    const box = scroller.current;
    if (!box) return;
    const top = index * rowHeight;
    const view = box.clientHeight || FALLBACK_HEIGHT;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (top + rowHeight > box.scrollTop + view) box.scrollTop = top + rowHeight - view;
    setScrollTop(box.scrollTop);
  };

  const visibleHeight = height || FALLBACK_HEIGHT;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + visibleHeight) / rowHeight) + OVERSCAN);

  const move = (index: number) => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!target) return;
    setFocused(target.node.path);
    scrollTo(rows.indexOf(target));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const row = rows[cursor];
    if (!row) return;
    const { node } = row;
    switch (event.key) {
      case "ArrowDown":
        move(cursor + 1);
        break;
      case "ArrowUp":
        move(cursor - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (node.type === "folder") {
          if (!expanded.has(node.path)) onToggle(node.path);
          else if (rows[cursor + 1]?.parent === node.path) move(cursor + 1);
        }
        break;
      case "ArrowLeft":
        if (node.type === "folder" && expanded.has(node.path)) onToggle(node.path);
        else if (row.parent !== "") move(indexOfPath(row.parent));
        break;
      case "Enter":
      case " ":
        if (node.type === "folder") onToggle(node.path);
        else onOpen(node);
        break;
      case "F2":
        onRename(node);
        break;
      case "Delete":
        onDelete(node);
        break;
      case "ContextMenu":
      case "F10": {
        if (event.key === "F10" && !event.shiftKey) return;
        const box = scroller.current?.getBoundingClientRect();
        onMenu({
          node,
          x: (box?.left ?? 0) + 24,
          y: (box?.top ?? 0) + (cursor + 1) * rowHeight - (scroller.current?.scrollTop ?? 0),
        });
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  // ---- drag and drop ---------------------------------------------------------------------

  const folderOf = (node: TreeNode | null): string =>
    node === null
      ? ""
      : node.type === "folder"
        ? node.path
        : node.path.split("/").slice(0, -1).join("/");

  const canDrop = (data: DataTransfer, folder: string): boolean => {
    if (data.types.includes("Files")) return true;
    const from = dragging.current;
    if (!from) return false;
    // Not into itself or its own subfolder, and not where it already is.
    return !isInside(folder, from) && folderOf({ path: from } as TreeNode) !== folder;
  };

  const dragOver = (event: DragEvent, node: TreeNode | null) => {
    const folder = folderOf(node);
    // A row decides for itself; only the empty area below the rows speaks for the root.
    if (node !== null) event.stopPropagation();
    if (!canDrop(event.dataTransfer, folder)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes("Files") ? "copy" : "move";
    setDropTarget(folder);
  };

  const drop = (event: DragEvent, node: TreeNode | null) => {
    const folder = folderOf(node);
    setDropTarget(null);
    if (!canDrop(event.dataTransfer, folder)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.types.includes("Files")) onDropFiles(event.dataTransfer, folder);
    else if (dragging.current) onMove(dragging.current, folder);
    dragging.current = null;
  };

  const renderRow = (row: Row, index: number) => {
    const { node } = row;
    const isFolder = node.type === "folder";
    const isOpen = isFolder && expanded.has(node.path);
    const isActive = activePath !== null && node.path === activePath;
    return (
      <div
        key={node.path}
        id={rowId(index)}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-posinset={row.position}
        aria-setsize={row.siblings}
        aria-expanded={isFolder ? isOpen : undefined}
        aria-selected={isActive}
        aria-current={isActive ? "page" : undefined}
        className="tree-row"
        data-focused={index === cursor || undefined}
        data-drop={(isFolder && dropTarget === node.path) || undefined}
        style={{ top: index * rowHeight, height: rowHeight, paddingLeft: 8 + row.depth * 16 }}
        draggable
        onDragStart={(event) => {
          dragging.current = node.path;
          event.dataTransfer.setData(DRAG_TYPE, node.path);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          dragging.current = null;
          setDropTarget(null);
        }}
        onDragOver={(event) => dragOver(event, node)}
        onDrop={(event) => drop(event, node)}
        onClick={() => {
          setFocused(node.path);
          if (isFolder) onToggle(node.path);
          else onOpen(node);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setFocused(node.path);
          onMenu({ node, x: event.clientX, y: event.clientY });
        }}
      >
        {isFolder ? (
          <span className="tree-chevron" data-open={isOpen || undefined}>
            <Icon name="chevron" />
          </span>
        ) : (
          <span className="tree-chevron" />
        )}
        <Icon name={iconFor(node)} />
        <span className="tree-name" title={node.path}>
          {node.name}
        </span>
        <button
          type="button"
          className="tree-more"
          tabIndex={-1}
          aria-label={t("files.actions", { name: node.name })}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setFocused(node.path);
            onMenu({ node, x: rect.right, y: rect.bottom });
          }}
        >
          <Icon name="more" />
        </button>
      </div>
    );
  };

  return (
    <div
      ref={scroller}
      className="tree-scroll"
      data-drop={dropTarget === "" || undefined}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onDragOver={(event) => dragOver(event, null)}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
      }}
      onDrop={(event) => drop(event, null)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ node: null, x: event.clientX, y: event.clientY });
      }}
    >
      <div
        role="tree"
        aria-label={t("files.tree")}
        aria-activedescendant={rows.length > 0 ? rowId(cursor) : undefined}
        tabIndex={0}
        className="tree"
        style={{ height: rows.length * rowHeight }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused((f) => f ?? rows[cursor]?.node.path ?? null)}
      >
        {rows.slice(first, last).map((row, i) => renderRow(row, first + i))}
      </div>
      {rows.length === 0 && (
        <div className="tree-empty">
          <p>{t("files.empty")}</p>
          <p className="muted">{t("files.emptyHint")}</p>
        </div>
      )}
    </div>
  );
}
