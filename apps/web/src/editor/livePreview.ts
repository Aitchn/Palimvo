import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { editorLabels } from "./labels.ts";
import {
  followLinkEvent,
  imageSize,
  isExternal,
  markdownHost,
  mediaSrc,
  openHref,
  renderInline,
  renderMath,
  renderMermaid,
} from "./render.ts";

/** Markdown syntax marks hidden when the cursor is not on their line. */
const HIDDEN_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "HighlightMark",
]);
const HEADING_LINE = /^(?:ATX|Setext)Heading(\d)$/;
const CODE_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "Frontmatter",
  "InlineMath",
  "BlockMath",
  "HTMLBlock",
  "CommentBlock",
  "URL",
]);
const CALLOUT = /^(\s*>\s*)\[!([\w-]+)\]([+-]?)[ \t]*/;
const TAG = /(^|[\s(（，。、])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const FOOTNOTE = /\[\^([^\]\s]+)\]/g;
const COMMENT = /%%[\s\S]*?%%/g;

const hide = Decoration.replace({});
const REPLACES = new Set<Decoration>([hide]);

/** Lines that contain any part of the selection; their syntax stays visible for editing. */
export function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  // A read-only view (a canvas card not being edited) shows every line rendered.
  if (!state.facet(EditorView.editable)) return lines;
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return lines;
}

/** Whether the selection touches [from, to]: a list marker turns back into text only when the cursor is at it. */
function touched(state: EditorState, from: number, to: number): boolean {
  if (!state.facet(EditorView.editable)) return false;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-checkbox";
    box.checked = this.checked;
    const labels = view.state.facet(editorLabels);
    box.setAttribute("aria-label", this.checked ? labels.taskDone : labels.taskTodo);
    box.onmousedown = (e) => e.preventDefault();
    box.onclick = (e) => {
      if (!view.state.facet(EditorView.editable)) {
        e.preventDefault();
        return;
      }
      // Find "[ ]" from where this widget is now, not where it was when drawn.
      const at = view.posAtDOM(box);
      const line = view.state.doc.lineAt(at);
      const open = line.text.indexOf("[", at - line.from);
      if (open < 0) return;
      view.dispatch({
        changes: {
          from: line.from + open + 1,
          to: line.from + open + 2,
          insert: this.checked ? " " : "x",
        },
      });
    };
    return box;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class CodeHeaderWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
  ) {
    super();
  }
  eq(other: CodeHeaderWidget): boolean {
    return other.lang === this.lang && other.code === this.code;
  }
  toDOM(view: EditorView): HTMLElement {
    const labels = view.state.facet(editorLabels);
    const wrap = document.createElement("span");
    wrap.className = "cm-codeblock-header";
    const label = document.createElement("span");
    label.className = "cm-codeblock-lang";
    label.textContent = this.lang;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "cm-codeblock-copy";
    copy.textContent = labels.copy;
    copy.onmousedown = (e) => e.preventDefault();
    copy.onclick = () => {
      void navigator.clipboard?.writeText(this.code).then(() => {
        copy.textContent = labels.copied;
        setTimeout(() => (copy.textContent = labels.copy), 1200);
      });
    };
    wrap.append(label, copy);
    return wrap;
  }
  ignoreEvent(e: Event): boolean {
    return (e.target as HTMLElement).closest?.(".cm-codeblock-copy") != null;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width?: number,
    readonly height?: number,
  ) {
    super();
  }
  eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    if (this.alt) img.title = this.alt;
    if (this.width) img.width = this.width;
    if (this.height) img.height = this.height;
    img.onload = () => view.requestMeasure();
    img.onerror = () => img.classList.add("cm-md-image-broken");
    return img;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly block: boolean,
  ) {
    super();
  }
  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display && other.block === this.block;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.block ? "div" : "span");
    el.className = this.block ? "cm-math cm-math-block" : "cm-math";
    renderMath(el, this.tex, this.display, () => view.requestMeasure());
    return el;
  }
}

class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-mermaid";
    renderMermaid(el, this.source, view.state.facet(editorLabels), () => view.requestMeasure());
    return el;
  }
}

interface TableCell {
  text: string;
  from: number;
}
type Align = "left" | "center" | "right" | null;

class TableWidget extends WidgetType {
  constructor(
    readonly rows: TableCell[][],
    readonly aligns: Align[],
    readonly source: string,
  ) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const host = view.state.facet(markdownHost);
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-table";
    const columns = Math.max(this.aligns.length, ...this.rows.map((r) => r.length));
    this.rows.forEach((row, index) => {
      const section = index === 0 ? table.createTHead() : (table.tBodies[0] ?? table.createTBody());
      const tr = section.insertRow();
      for (let c = 0; c < columns; c++) {
        const cell = document.createElement(index === 0 ? "th" : "td");
        const data = row[c];
        if (data) {
          renderInline(data.text, cell, host);
          cell.dataset.pos = String(data.from);
        }
        const align = this.aligns[c];
        if (align) cell.style.textAlign = align;
        tr.append(cell);
      }
    });
    wrap.append(table);
    wrap.onmousedown = (e) => {
      if (followLinkEvent(e, host)) return;
      if (!view.state.facet(EditorView.editable)) return;
      // Clicking a cell edits the table's source with the cursor in that cell.
      const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-pos]");
      const row = (e.target as HTMLElement).closest("tr");
      const pos = cell?.dataset.pos ?? row?.querySelector<HTMLElement>("[data-pos]")?.dataset.pos;
      if (pos === undefined) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: Math.min(Number(pos), view.state.doc.length) } });
      view.focus();
    };
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const CALLOUT_ICONS: Record<string, string> = {
  note: "✎",
  abstract: "☰",
  summary: "☰",
  tldr: "☰",
  info: "ℹ",
  todo: "☑",
  tip: "✦",
  hint: "✦",
  important: "✦",
  success: "✓",
  check: "✓",
  done: "✓",
  question: "?",
  help: "?",
  faq: "?",
  warning: "⚠",
  caution: "⚠",
  attention: "⚠",
  failure: "✗",
  fail: "✗",
  missing: "✗",
  danger: "⚡",
  error: "⚡",
  bug: "🐞",
  example: "▤",
  quote: "❝",
  cite: "❝",
};
const CALLOUT_ALIASES: Record<string, string> = {
  summary: "abstract",
  tldr: "abstract",
  hint: "tip",
  important: "tip",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  caution: "warning",
  attention: "warning",
  fail: "failure",
  missing: "failure",
  error: "danger",
  cite: "quote",
};

/** The callout kind that decides its colour: [!faq] looks like [!question]; unknown kinds look like [!note]. */
export function calloutKind(type: string): string {
  const t = type.toLowerCase();
  const kind = CALLOUT_ALIASES[t] ?? t;
  return CALLOUT_ICONS[kind] ? kind : "note";
}

class CalloutTitleWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly label: string | null,
  ) {
    super();
  }
  eq(other: CalloutTitleWidget): boolean {
    return other.type === this.type && other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-callout-icon";
    span.textContent = CALLOUT_ICONS[calloutKind(this.type)] ?? "✎";
    if (this.label !== null) {
      const label = document.createElement("span");
      label.className = "cm-callout-label";
      label.textContent = this.label;
      span.append(label);
    }
    return span;
  }
}

class FootnoteWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: FootnoteWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const sup = document.createElement("sup");
    sup.className = "cm-footnote-ref";
    sup.textContent = this.label;
    return sup;
  }
}

function inCode(state: EditorState, pos: number): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

function tableData(
  state: EditorState,
  table: SyntaxNode,
): { rows: TableCell[][]; aligns: Align[] } {
  const rows: TableCell[][] = [];
  let aligns: Align[] = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableDelimiter") {
      aligns = state
        .sliceDoc(child.from, child.to)
        .replace(/^\s*\||\|\s*$/g, "")
        .split("|")
        .map((spec) => {
          const s = spec.trim();
          return s.startsWith(":") && s.endsWith(":")
            ? "center"
            : s.endsWith(":")
              ? "right"
              : s.startsWith(":")
                ? "left"
                : null;
        });
      continue;
    }
    if (child.name !== "TableHeader" && child.name !== "TableRow") continue;
    const delims = child.getChildren("TableDelimiter");
    const bounds: [number, number][] = [];
    let pos = child.from;
    for (const d of delims) {
      bounds.push([pos, d.from]);
      pos = d.to;
    }
    bounds.push([pos, child.to]);
    // "| a | b |": nothing before the first pipe or after the last one.
    if (delims.length && state.sliceDoc(child.from, delims[0]!.from).trim() === "") bounds.shift();
    if (delims.length && state.sliceDoc(pos, child.to).trim() === "") bounds.pop();
    rows.push(
      bounds.map(([from, to]) => {
        const raw = state.sliceDoc(from, to);
        const lead = raw.length - raw.trimStart().length;
        return { text: raw.trim(), from: from + lead };
      }),
    );
  }
  return { rows, aligns };
}

function build(state: EditorState): DecorationSet {
  const host = state.facet(markdownHost);
  const active = activeLines(state);
  const isActive = (from: number, to: number) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (active.has(n)) return true;
    return false;
  };
  const decos: Range<Decoration>[] = [];
  const line = (pos: number, cls: string) =>
    decos.push(Decoration.line({ class: cls }).range(state.doc.lineAt(pos).from));
  const calloutHeads = new Set<number>();

  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node;
      const name = node.name;
      const heading = HEADING_LINE.exec(name);
      if (heading) line(node.from, `cm-h${heading[1]}`);
      switch (name) {
        case "Frontmatter":
          return false;

        case "FencedCode": {
          const info = node.getChild("CodeInfo");
          const lang = info ? state.sliceDoc(info.from, info.to).trim() : "";
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          const marks = node.getChildren("CodeMark");
          const closed = marks.length > 1 && last.number > first.number;
          const text = node.getChild("CodeText");
          const code = text ? state.sliceDoc(text.from, text.to) : "";
          const editing = isActive(first.from, last.to);
          if (lang === "mermaid" && closed && code.trim()) {
            const widget = new MermaidWidget(code);
            decos.push(
              editing
                ? Decoration.widget({ widget, block: true, side: 1 }).range(last.to)
                : Decoration.replace({ widget, block: true }).range(first.from, last.to),
            );
            if (!editing) return false;
          }
          for (let n = first.number; n <= last.number; n++) {
            const l = state.doc.line(n);
            const cls = ["cm-codeblock"];
            if (n === first.number) cls.push("cm-codeblock-begin");
            if (n === last.number && closed) cls.push("cm-codeblock-end");
            decos.push(Decoration.line({ class: cls.join(" ") }).range(l.from));
          }
          if (!editing) {
            decos.push(
              Decoration.replace({ widget: new CodeHeaderWidget(lang, code) }).range(
                first.from,
                first.to,
              ),
            );
            if (closed && last.to > last.from) decos.push(hide.range(last.from, last.to));
          }
          return false;
        }

        case "CodeBlock": {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++)
            decos.push(
              Decoration.line({ class: "cm-codeblock cm-codeblock-indented" }).range(
                state.doc.line(n).from,
              ),
            );
          return false;
        }

        case "Table": {
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          if (isActive(first.from, last.to)) {
            for (let n = first.number; n <= last.number; n++)
              decos.push(
                Decoration.line({ class: "cm-table-source" }).range(state.doc.line(n).from),
              );
            return;
          }
          const { rows, aligns } = tableData(state, node);
          decos.push(
            Decoration.replace({
              widget: new TableWidget(rows, aligns, state.sliceDoc(first.from, last.to)),
              block: true,
            }).range(first.from, last.to),
          );
          return false;
        }

        case "BlockMath": {
          const marks = node.getChildren("MathMark");
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          const editing = isActive(first.from, last.to);
          if (marks.length < 2) return false;
          const tex = state.sliceDoc(marks[0]!.to, marks[1]!.from).trim();
          const widget = new MathWidget(tex, true, true);
          if (editing) {
            for (let n = first.number; n <= last.number; n++)
              decos.push(
                Decoration.line({ class: "cm-math-source" }).range(state.doc.line(n).from),
              );
            decos.push(Decoration.widget({ widget, block: true, side: 1 }).range(last.to));
          } else if (node.from === first.from && node.to === last.to) {
            decos.push(Decoration.replace({ widget, block: true }).range(first.from, last.to));
          } else {
            decos.push(Decoration.replace({ widget }).range(node.from, node.to));
          }
          return false;
        }

        case "InlineMath": {
          const marks = node.getChildren("MathMark");
          if (isActive(node.from, node.to)) {
            decos.push(Decoration.mark({ class: "cm-math-source" }).range(node.from, node.to));
          } else {
            const display = marks[0]!.to - marks[0]!.from === 2;
            decos.push(
              Decoration.replace({
                widget: new MathWidget(
                  state.sliceDoc(marks[0]!.to, marks[1]!.from),
                  display,
                  false,
                ),
              }).range(node.from, node.to),
            );
          }
          return false;
        }

        case "InlineCode":
          decos.push(Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to));
          break;

        case "Highlight":
          decos.push(Decoration.mark({ class: "cm-highlight" }).range(node.from, node.to));
          break;

        case "Escape":
          if (!isActive(node.from, node.to)) decos.push(hide.range(node.from, node.from + 1));
          return false;

        case "Blockquote": {
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          const callout = CALLOUT.exec(first.text);
          const kind = callout ? calloutKind(callout[2]!) : null;
          for (let n = first.number; n <= last.number; n++) {
            const cls = callout ? `cm-callout cm-callout-${kind}` : "cm-quote";
            const edges = `${n === first.number ? " cm-quote-first" : ""}${n === last.number ? " cm-quote-last" : ""}`;
            decos.push(
              Decoration.line({
                class: cls + edges + (callout && n === first.number ? " cm-callout-title" : ""),
              }).range(state.doc.line(n).from),
            );
          }
          if (callout && !active.has(first.number)) {
            calloutHeads.add(first.number);
            const end = first.from + callout[0].length;
            const titled = first.text.slice(callout[0].length).trim() !== "";
            const type = callout[2]!;
            const label = titled
              ? null
              : type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
            decos.push(
              Decoration.replace({ widget: new CalloutTitleWidget(type, label) }).range(
                first.from,
                end,
              ),
            );
          }
          break;
        }

        case "QuoteMark": {
          const l = state.doc.lineAt(node.from);
          if (active.has(l.number) || calloutHeads.has(l.number)) break;
          const end = state.sliceDoc(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
          decos.push(hide.range(node.from, end));
          break;
        }

        case "HorizontalRule": {
          line(node.from, "cm-hr");
          if (!isActive(node.from, node.to)) decos.push(hide.range(node.from, node.to));
          break;
        }

        case "ListItem": {
          const mark = node.getChild("ListMark");
          if (!mark) break;
          const task = node.getChild("Task")?.getChild("TaskMarker");
          if (task) {
            const checked = /x/i.test(state.sliceDoc(task.from, task.to));
            if (checked) {
              const end = Math.min(node.to, state.doc.lineAt(node.from).to);
              decos.push(Decoration.mark({ class: "cm-task-done" }).range(task.to, end));
            }
            if (!touched(state, mark.from, task.to))
              decos.push(
                Decoration.replace({ widget: new CheckboxWidget(checked) }).range(
                  mark.from,
                  task.to,
                ),
              );
          } else if (node.parent?.name === "BulletList" && !touched(state, mark.from, mark.to)) {
            decos.push(
              Decoration.replace({ widget: new BulletWidget() }).range(mark.from, mark.to),
            );
          }
          break;
        }

        case "Image": {
          const url = node.getChild("URL");
          const marks = node.getChildren("LinkMark");
          if (!url || marks.length < 2) break;
          const src = mediaSrc(host, state.sliceDoc(url.from, url.to));
          if (!src) break;
          const { alt, width, height } = imageSize(state.sliceDoc(marks[0]!.to, marks[1]!.from));
          const widget = new ImageWidget(src, alt, width, height);
          if (isActive(node.from, node.to))
            decos.push(Decoration.widget({ widget, side: 1 }).range(node.to));
          else decos.push(Decoration.replace({ widget }).range(node.from, node.to));
          return false;
        }

        case "Link": {
          const url = node.getChild("URL");
          const marks = node.getChildren("LinkMark");
          if (!url || marks.length < 2) break;
          const href = state.sliceDoc(url.from, url.to);
          const textFrom = marks[0]!.to;
          const textTo = marks[1]!.from;
          const rendered = !isActive(node.from, node.to);
          const attrs = { "data-href": href, ...(isExternal(href) ? { title: href } : {}) };
          if (rendered && textTo > textFrom) {
            decos.push(hide.range(node.from, textFrom));
            decos.push(
              Decoration.mark({ class: "cm-md-link cm-md-link-rendered", attributes: attrs }).range(
                textFrom,
                textTo,
              ),
            );
            decos.push(hide.range(textTo, node.to));
            // Inline formatting inside the link text still renders.
            return;
          }
          decos.push(
            Decoration.mark({ class: "cm-md-link", attributes: attrs }).range(node.from, node.to),
          );
          return false;
        }

        case "Autolink": {
          const url = node.getChild("URL");
          if (!url) break;
          const href = state.sliceDoc(url.from, url.to);
          const rendered = !isActive(node.from, node.to);
          if (rendered) decos.push(hide.range(node.from, url.from));
          decos.push(
            Decoration.mark({
              class: `cm-md-link${rendered ? " cm-md-link-rendered" : ""}`,
              attributes: { "data-href": href },
            }).range(url.from, url.to),
          );
          if (rendered) decos.push(hide.range(url.to, node.to));
          return false;
        }

        case "URL": {
          // A bare https://… or www.… in text (GFM autolink).
          const parent = node.parent?.name;
          if (
            parent === "Link" ||
            parent === "Image" ||
            parent === "LinkReference" ||
            parent === "Autolink"
          )
            break;
          const rendered = !isActive(node.from, node.to);
          decos.push(
            Decoration.mark({
              class: `cm-md-link${rendered ? " cm-md-link-rendered" : ""}`,
              attributes: { "data-href": state.sliceDoc(node.from, node.to) },
            }).range(node.from, node.to),
          );
          break;
        }
      }
      if (HIDDEN_MARKS.has(name) && !active.has(state.doc.lineAt(node.from).number)) {
        let end = node.to;
        // Hide the space after "#" too, so headings start flush.
        if (name === "HeaderMark" && state.sliceDoc(end, end + 1) === " ") end++;
        decos.push(hide.range(node.from, end));
      }
      return;
    },
  });

  const text = state.doc.toString();

  // %% comments %% are hidden unless being edited.
  const hiddenComments: [number, number][] = [];
  for (const m of text.matchAll(COMMENT)) {
    const from = m.index;
    const to = from + m[0].length;
    if (inCode(state, from)) continue;
    if (!isActive(from, to)) {
      decos.push(hide.range(from, to));
      hiddenComments.push([from, to]);
    } else {
      decos.push(Decoration.mark({ class: "cm-comment" }).range(from, to));
    }
  }
  const inComment = (pos: number) => hiddenComments.some(([a, b]) => pos >= a && pos < b);

  for (const m of text.matchAll(TAG)) {
    const from = m.index + m[1]!.length;
    const to = from + 1 + m[2]!.length;
    if (inCode(state, from) || inComment(from)) continue;
    decos.push(
      Decoration.mark({ class: "cm-tag", attributes: { "data-tag": m[2]! } }).range(from, to),
    );
  }

  for (const m of text.matchAll(FOOTNOTE)) {
    const from = m.index;
    const to = from + m[0].length;
    if (inCode(state, from) || inComment(from)) continue;
    const l = state.doc.lineAt(from);
    if (from === l.from && text[to] === ":") {
      decos.push(Decoration.mark({ class: "cm-footnote-def" }).range(from, to));
      // The parser reads "[^1]: text" as a link definition; show the text as ordinary text.
      if (l.to > to + 1)
        decos.push(Decoration.mark({ class: "cm-footnote-body" }).range(to + 1, l.to));
    } else if (!active.has(l.number)) {
      decos.push(Decoration.replace({ widget: new FootnoteWidget(m[1]!) }).range(from, to));
    } else {
      decos.push(Decoration.mark({ class: "cm-footnote-source" }).range(from, to));
    }
  }

  return Decoration.set(dropOverlaps(decos), true);
}

/** Replacements may not overlap; when they do (a footnote inside a hidden comment), the earlier, wider one wins. */
function dropOverlaps(decos: Range<Decoration>[]): Range<Decoration>[] {
  const replaces = decos.filter(
    (d) => REPLACES.has(d.value) || (d.value.spec.widget !== undefined && d.from < d.to),
  );
  replaces.sort((a, b) => a.from - b.from || b.to - a.to);
  const dropped = new Set<Range<Decoration>>();
  let coverTo = -1;
  for (const r of replaces) {
    if (r.from < coverTo) dropped.add(r);
    else coverTo = Math.max(coverTo, r.to);
  }
  return dropped.size ? decos.filter((d) => !dropped.has(d)) : decos;
}

/** Obsidian-style live preview: rendered markdown, raw syntax only where the cursor is. */
export const livePreview = [
  StateField.define<DecorationSet>({
    create: build,
    update(value, tr) {
      if (
        !tr.docChanged &&
        !tr.selection &&
        syntaxTree(tr.startState) === syntaxTree(tr.state) &&
        tr.startState.facet(EditorView.editable) === tr.state.facet(EditorView.editable)
      )
        return value;
      return build(tr.state);
    },
    provide: (field) => EditorView.decorations.from(field),
  }),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const link = (event.target as HTMLElement).closest<HTMLElement>(".cm-md-link");
      if (!link) return false;
      // Rendered links open on click; links on the line being edited need Ctrl/Cmd+click.
      if (!link.classList.contains("cm-md-link-rendered") && !(event.metaKey || event.ctrlKey))
        return false;
      event.preventDefault();
      openHref(view.state.facet(markdownHost), link.dataset.href ?? "");
      return true;
    },
  }),
];
