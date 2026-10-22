import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.tsx";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type OverlayKind = "dialog" | "sheet";
export type SheetSide = "left" | "right" | "bottom";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  kind: OverlayKind;
  side?: SheetSide;
  /** Hides the title bar's text (the title still labels the panel for screen readers). */
  hideTitle?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

let locks = 0;

/**
 * Shared behaviour of Dialog and Sheet: a portal with a backdrop, Escape and backdrop click to
 * close, focus moved in and kept inside, focus returned to whatever opened it, page scroll locked.
 */
export function Overlay({
  open,
  onClose,
  title,
  kind,
  side = "right",
  hideTitle,
  footer,
  children,
  className,
}: Props) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    locks += 1;
    document.body.style.overflow = "hidden";
    const node = panel.current;
    (
      node?.querySelector<HTMLElement>("[data-autofocus]") ??
      node?.querySelector<HTMLElement>(FOCUSABLE) ??
      node
    )?.focus();
    return () => {
      locks -= 1;
      if (locks === 0) document.body.style.overflow = "";
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === panel.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="overlay-backdrop"
      data-kind={kind}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={["overlay", kind === "sheet" ? `sheet sheet-${side}` : "dialog", className ?? ""]
          .filter(Boolean)
          .join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="overlay-header">
          <h2 id={titleId} className={hideTitle ? "sr-only" : "overlay-title"}>
            {title}
          </h2>
          <Button variant="ghost" icon="close" aria-label={t("common.close")} onClick={onClose} />
        </header>
        <div className="overlay-body">{children}</div>
        {footer && <footer className="overlay-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
