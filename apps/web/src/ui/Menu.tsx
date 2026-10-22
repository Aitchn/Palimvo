import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon.tsx";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Present: the item is a radio-style choice and this says whether it is the current one. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface Props {
  /** Accessible name of the trigger button. */
  label: string;
  items: MenuItem[];
  /** The trigger's visible content (usually an Icon). */
  children: ReactNode;
  /** Where the menu opens relative to the trigger. */
  align?: "start" | "end";
  placement?: "below" | "right";
  className?: string;
}

/** A button that opens a menu: arrow keys, Home/End, Escape, and a click outside close or move. */
export function Menu({
  label,
  items,
  children,
  align = "start",
  placement = "below",
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const menuWidth = list.current?.offsetWidth ?? 200;
    const left =
      placement === "right"
        ? rect.right + 6
        : align === "end"
          ? Math.max(8, rect.right - menuWidth)
          : Math.min(rect.left, window.innerWidth - menuWidth - 8);
    const menuHeight = list.current?.offsetHeight ?? 0;
    const top =
      placement === "right"
        ? Math.min(rect.top, Math.max(8, window.innerHeight - menuHeight - 8))
        : Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - menuHeight - 8));
    setPosition({ top, left });
  }, [open, align, placement, items.length]);

  useEffect(() => {
    if (!open) return;
    const enabled = () => [
      ...(list.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? []),
    ];
    const selected = list.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (selected ?? enabled()[0])?.focus();
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const resize = () => setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    setPosition(null);
    if (refocus) trigger.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const nodes = [
      ...(list.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
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
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(false);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={["btn", "btn-ghost", "btn-icon", className ?? ""].filter(Boolean).join(" ")}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="menu"
            aria-label={label}
            className="menu"
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
            onKeyDown={onKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
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
                {item.checked && <Icon name="check" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
