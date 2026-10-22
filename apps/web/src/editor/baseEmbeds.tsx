import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import { BaseView, type BaseTarget } from "../bases/BaseView.tsx";
import { MissingBase } from "../bases/MissingBase.tsx";
import { activeLines } from "./livePreview.ts";

/** What databases shown inside markdown need from the app. */
export interface BaseEmbedHost {
  vault: string;
  /** The note the markdown belongs to: `this` in the database's filters. */
  thisPath?: string | undefined;
  canEdit: boolean;
  /** Finds the file a `![[name.base]]` names. */
  resolve: (target: string) => string | undefined;
  open: (path: string) => void;
  openLink: (target: string) => void;
}

export const setBaseEmbeds = StateEffect.define<BaseEmbedHost>();

const sameHost = (a: BaseEmbedHost, b: BaseEmbedHost) =>
  a.vault === b.vault && a.thisPath === b.thisPath && a.canEdit === b.canEdit;

/** A line that is only `![[name.base]]`, optionally `#view` and `|alias`. */
const EMBED_LINE = /^\s*!\[\[([^\]|#]+?\.base)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]\s*$/i;

type Embed =
  { kind: "file"; target: string; view?: string | undefined } | { kind: "inline"; source: string };

type WidgetDom = HTMLElement & { baseRoot?: Root };

class BaseWidget extends WidgetType {
  constructor(
    readonly host: BaseEmbedHost,
    readonly embed: Embed,
  ) {
    super();
  }

  eq(other: BaseWidget): boolean {
    const a = this.embed;
    const b = other.embed;
    if (!sameHost(other.host, this.host) || a.kind !== b.kind) return false;
    if (a.kind === "file" && b.kind === "file")
      // Draw again once the file list arrives (or changes) and the name resolves differently.
      return (
        a.target === b.target &&
        a.view === b.view &&
        this.host.resolve(a.target) === other.host.resolve(a.target)
      );
    return a.kind === "inline" && b.kind === "inline" && a.source === b.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap: WidgetDom = document.createElement("div");
    wrap.className = "cm-base-embed";
    // Typing, clicking and selecting inside the database never reach the editor below it.
    wrap.addEventListener("keydown", (e) => e.stopPropagation());
    const root = createRoot(wrap);
    wrap.baseRoot = root;
    this.render(root, view, wrap);
    return wrap;
  }

  /** Same kind of embed with new settings (a ```base block was edited): draw in place, keeping open panels. */
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const root = (dom as WidgetDom).baseRoot;
    if (!root) return false;
    this.render(root, view, dom);
    return true;
  }

  private render(root: Root, view: EditorView, dom: HTMLElement): void {
    const { host, embed } = this;
    let target: BaseTarget | null;
    if (embed.kind === "file") {
      const path = host.resolve(embed.target);
      target = path ? { kind: "file", path } : null;
    } else {
      target = {
        kind: "inline",
        source: embed.source,
        thisPath: host.thisPath,
        onChange:
          host.canEdit && view.state.facet(EditorView.editable)
            ? (next) => replaceBlock(view, dom, embed.source, next)
            : undefined,
      };
    }
    root.render(
      target ? (
        <BaseView
          key={target.kind === "file" ? target.path : "inline"}
          vault={host.vault}
          target={target}
          initialView={embed.kind === "file" ? embed.view : undefined}
          canEdit={host.canEdit}
          onOpen={host.open}
          onOpenLink={host.openLink}
          embedded
        />
      ) : (
        <MissingBase name={embed.kind === "file" ? embed.target : ""} />
      ),
    );
  }

  destroy(dom: HTMLElement): void {
    const root = (dom as WidgetDom).baseRoot;
    // React may be rendering when CodeMirror drops the widget; unmount right after.
    if (root) queueMicrotask(() => root.unmount());
  }

  ignoreEvent(): boolean {
    return true;
  }

  get estimatedHeight(): number {
    return 240;
  }
}

/**
 * Writes changed settings back into the ```base block this widget stands for. The block is found
 * by where the widget is in the document now (two blocks may hold the same YAML), and only
 * replaced while it still holds `previous`.
 */
function replaceBlock(view: EditorView, dom: HTMLElement, previous: string, next: string): void {
  let at: number;
  try {
    at = view.posAtDOM(dom);
  } catch {
    return;
  }
  let range: { from: number; to: number } | null = null;
  syntaxTree(view.state).iterate({
    from: at,
    to: at,
    enter(node) {
      if (range) return false;
      if (node.name !== "FencedCode") return undefined;
      const info = node.node.getChild("CodeInfo");
      if (!info || view.state.sliceDoc(info.from, info.to).trim() !== "base") return false;
      const text = node.node.getChild("CodeText");
      if (text && view.state.sliceDoc(text.from, text.to) === previous)
        range = { from: text.from, to: text.to };
      return false;
    },
  });
  if (!range) return;
  const { from, to } = range as { from: number; to: number };
  view.dispatch({ changes: { from, to, insert: next.replace(/\n+$/, "") } });
}

function build(state: EditorState, host: BaseEmbedHost | null): DecorationSet {
  if (!host) return Decoration.none;
  const active = activeLines(state);
  const decos: Range<Decoration>[] = [];
  const code: { from: number; to: number }[] = [];
  const place = (embed: Embed, fromLine: number, toLine: number) => {
    const first = state.doc.line(fromLine);
    const last = state.doc.line(toLine);
    const widget = new BaseWidget(host, embed);
    let editing = false;
    for (let n = fromLine; n <= toLine; n++) if (active.has(n)) editing = true;
    // While the cursor is on it, the source stays visible with the database below it.
    decos.push(
      editing
        ? Decoration.widget({ widget, block: true, side: 1 }).range(last.to)
        : Decoration.replace({ widget, block: true }).range(first.from, last.to),
    );
  };

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode" && node.name !== "CodeBlock" && node.name !== "Frontmatter")
        return;
      code.push({ from: node.from, to: node.to });
      if (node.name === "FencedCode") {
        const info = node.node.getChild("CodeInfo");
        const closed = node.node.getChildren("CodeMark").length > 1;
        if (
          info &&
          closed &&
          state.sliceDoc(info.from, info.to).trim() === "base" &&
          state.doc.lineAt(node.to).number > state.doc.lineAt(node.from).number
        ) {
          const text = node.node.getChild("CodeText");
          place(
            { kind: "inline", source: text ? state.sliceDoc(text.from, text.to) : "" },
            state.doc.lineAt(node.from).number,
            state.doc.lineAt(node.to).number,
          );
        }
      }
      return false;
    },
  });

  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!line.text.includes(".base")) continue;
    const m = EMBED_LINE.exec(line.text);
    if (!m || code.some((c) => line.from >= c.from && line.from <= c.to)) continue;
    place({ kind: "file", target: m[1]!.trim(), view: m[2]?.trim() }, n, n);
  }
  return Decoration.set(decos, true);
}

/** Shows `![[name.base]]` lines and ```base blocks as the database itself. */
export const baseEmbeds = StateField.define<{
  host: BaseEmbedHost | null;
  decorations: DecorationSet;
}>({
  create: (state) => ({ host: null, decorations: build(state, null) }),
  update(value, tr) {
    let host = value.host;
    for (const e of tr.effects) if (e.is(setBaseEmbeds)) host = e.value;
    if (
      host === value.host &&
      !tr.docChanged &&
      !tr.selection &&
      syntaxTree(tr.startState) === syntaxTree(tr.state)
    )
      return value;
    return { host, decorations: build(tr.state, host) };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});
