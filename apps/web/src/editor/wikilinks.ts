import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { noteTitle } from "@palimvo/core";
import { EmbedWidget } from "./embed.ts";
import { activeLines } from "./livePreview.ts";

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const CODE_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "Frontmatter",
  "InlineMath",
  "BlockMath",
]);

export interface WikiLinkHost {
  /** Returns the resolved vault path for a link target, or undefined if no such note exists. */
  resolve(target: string): string | undefined;
  /** Opens (or creates) the note a link points to. */
  open(target: string): void;
  /** All file paths in the vault, for autocompletion. */
  paths(): readonly string[];
  /** URL of a vault file's bytes, for images and other embeds. */
  fileUrl?(path: string): string;
  /** A vault note's text, for ![[note]] embeds. */
  readText?(path: string): Promise<string>;
}

const hide = Decoration.replace({});

/** Dispatch this when the vault's file list changes so link resolution is re-evaluated. */
export const refreshWikiLinks = StateEffect.define<null>();

function inCode(view: EditorView, pos: number): boolean {
  for (
    let node: { name: string; parent: unknown } | null = syntaxTree(view.state).resolveInner(
      pos,
      1,
    );
    node;
    node = node.parent as typeof node
  ) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

function build(view: EditorView, host: WikiLinkHost): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const active = activeLines(view.state);
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (const m of text.matchAll(WIKILINK)) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (inCode(view, start)) continue;
      const inner = m[2]!;
      const pipe = inner.indexOf("|");
      const [target = "", section = ""] = (pipe >= 0 ? inner.slice(0, pipe) : inner)
        .split("#")
        .map((s) => s.trim());
      const path = host.resolve(target);
      const resolved = path !== undefined;
      const rendered = !active.has(view.state.doc.lineAt(start).number);
      if (m[1] && path && rendered) {
        // ![[embed]]: the image or note itself instead of a link.
        builder.add(
          start,
          end,
          Decoration.replace({
            widget: new EmbedWidget(path, section, pipe >= 0 ? inner.slice(pipe + 1).trim() : ""),
          }),
        );
        continue;
      }
      const cls = `cm-wikilink${resolved ? "" : " cm-wikilink-unresolved"}${rendered ? " cm-wikilink-rendered" : ""}`;
      const mark = Decoration.mark({ class: cls, attributes: { "data-target": target } });
      const openLen = m[1]!.length + 2;
      const textStart = start + openLen;
      const textEnd = end - 2;
      if (rendered) {
        // Show only the alias (or the target) between hidden brackets.
        const shownFrom = pipe >= 0 ? textStart + pipe + 1 : textStart;
        builder.add(start, shownFrom, hide);
        builder.add(shownFrom, textEnd, mark);
        builder.add(textEnd, end, hide);
      } else {
        builder.add(start, end, mark);
      }
    }
  }
  return builder.finish();
}

function completions(host: WikiLinkHost) {
  return (context: CompletionContext) => {
    const before = context.matchBefore(/\[\[[^[\]|#\n]*/);
    if (!before) return null;
    const from = before.from + 2;
    const options: Completion[] = host.paths().map((path) => {
      const title = noteTitle(path);
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      return {
        label: title,
        detail: folder,
        apply: (view, _completion, applyFrom, applyTo) => {
          const hasClose = view.state.sliceDoc(applyTo, applyTo + 2) === "]]";
          const insert = title + (hasClose ? "" : "]]");
          view.dispatch({
            changes: { from: applyFrom, to: applyTo, insert },
            selection: { anchor: applyFrom + title.length + 2 },
          });
        },
      };
    });
    return { from, options, validFor: /^[^[\]|#\n]*$/ };
  };
}

/** Clickable [[wikilinks]] with live-preview rendering and [[ autocompletion. */
export function wikiLinks(host: WikiLinkHost) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, host);
      }
      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshWikiLinks)),
        );
        if (
          refreshed ||
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = build(update.view, host);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(event) {
      const link = (event.target as HTMLElement).closest<HTMLElement>(".cm-wikilink");
      if (!link) return false;
      // Rendered links open on click; links on the line being edited need Ctrl/Cmd+click.
      if (!link.classList.contains("cm-wikilink-rendered") && !(event.metaKey || event.ctrlKey))
        return false;
      event.preventDefault();
      host.open(link.dataset.target ?? "");
      return true;
    },
  });

  return [plugin, clicks, autocompletion({ override: [completions(host)] })];
}
