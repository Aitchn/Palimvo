import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";
import type { MenuItem } from "./Menu.tsx";

interface Props {
  /** Accessible name of the menu. */
  label: string;
  items: MenuItem[];
  /** Viewport position it opens at (a right click, or the corner of the button that opened it). */
  x: number;
  y: number;
  /** `refocus`: put focus back where it was (the item was chosen or Escape was pressed). */
  onClose: (refocus: boolean) => void;
}

/** A menu opened at a point, like a right-click menu. Same keys and look as {@link Menu}. */
export function ContextMenu({ label, items, x, y, onClose }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const box = list.current;
    const width = box?.offsetWidth ?? 200;
    const height = box?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
  }, [x, y, items.length]);

  // What had focus before the menu opened gets it back when the menu closes by keyboard or choice.
  const opener = useRef<Element | null>(document.activeElement);
  const close = (refocus: boolean) => {
    onClose(refocus);
    if (refocus && opener.current instanceof HTMLElement) opener.current.focus();
  };

  // Focus the first item once the menu is placed and visible (a hidden element cannot take focus).
  const placed = position !== null;
  useEffect(() => {
    if (placed) {
      list.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
        ?.focus();
    }
  }, [placed]);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!list.current?.contains(event.target as Node)) onClose(false);
    };
    const dismiss = () => onClose(false);
    // Escape closes the menu even if focus has wandered off it (a screenshot, a click on nothing).
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
    // Registered once for the lifetime of this open menu.
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const nodes = [
      ...(list.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      ) ?? []),
    ];
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      event.preventDefault();
      nodes[(index + nodes.length) % nodes.length]?.focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? nodes.length - 1 : at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(nodes.length - 1);
    else if (event.key === "Tab") close(false);
  };

  return createPortal(
    <div
      ref={list}
      role="menu"
      aria-label={label}
      className="menu"
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-disabled={item.disabled || undefined}
          className={["menu-item", item.danger ? "danger" : ""].filter(Boolean).join(" ")}
          tabIndex={-1}
          onClick={() => {
            if (item.disabled) return;
            close(true);
            item.onSelect();
          }}
        >
          {item.icon ? <Icon name={item.icon} /> : <span className="menu-item-gap" />}
          <span className="menu-item-label">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
