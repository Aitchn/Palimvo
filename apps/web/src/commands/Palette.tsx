import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon, Overlay, type IconName } from "../ui/index.ts";

export interface PaletteItem {
  id: string;
  title: string;
  /** Dimmer text after the title (the folder of a file). */
  detail?: string;
  /** Right-aligned (a shortcut). */
  hint?: string;
  icon?: IconName;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Names the dialog for screen readers. */
  title: string;
  placeholder: string;
  emptyText: string;
  /** The items to show for what has been typed. */
  search: (query: string) => PaletteItem[];
  onChoose: (id: string) => void;
}

/** A search box over a list, driven by the keyboard: the shell of both quick open and the command palette. */
export function Palette({ open, onClose, title, placeholder, emptyText, search, onChoose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo(() => (open ? search(query) : []), [open, query, search]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    onChoose(item.id);
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      kind="dialog"
      title={title}
      hideTitle
      className="palette"
    >
      <input
        data-autofocus
        className="input palette-input"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={items[index] ? `${listId}-${index}` : undefined}
        aria-label={title}
        placeholder={placeholder}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setIndex((i) => Math.min(items.length - 1, i + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            choose(items[index]);
          }
        }}
      />
      <div ref={list} id={listId} role="listbox" aria-label={title} className="palette-list">
        {items.length === 0 && <p className="muted palette-empty">{emptyText}</p>}
        {items.map((item, i) => (
          <div
            key={item.id}
            id={`${listId}-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === index}
            className="palette-item"
            onMouseMove={() => setIndex(i)}
            onClick={() => choose(item)}
          >
            {item.icon && <Icon name={item.icon} />}
            <span className="palette-title">{item.title}</span>
            {item.detail && <span className="palette-detail">{item.detail}</span>}
            {item.hint && <kbd className="palette-hint">{item.hint}</kbd>}
          </div>
        ))}
      </div>
    </Overlay>
  );
}
