import { yamlLanguage } from "@codemirror/lang-yaml";
import { StateEffect, StateField, type EditorState, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorLabels } from "./labels.ts";

interface FrontmatterRange {
  from: number;
  to: number;
}

/** Only complete leading YAML property maps qualify; ordinary rules and broken YAML stay visible. */
export function frontmatterRange(doc: Text): FrontmatterRange | null {
  if (doc.line(1).text !== "---") return null;
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.text !== "---") continue;
    const tree = yamlLanguage.parser.parse(doc.sliceString(doc.line(2).from, line.from));
    const documents = tree.topNode.getChildren("Document");
    const value = documents.length === 1 ? documents[0]!.firstChild : null;
    if (!value || (value.name !== "BlockMapping" && value.name !== "FlowMapping")) return null;
    let invalid = false;
    tree.iterate({
      enter: (node) => {
        if (node.type.isError) invalid = true;
      },
    });
    return invalid ? null : { from: 0, to: line.to };
  }
  return null;
}

export const setFrontmatterExpanded = StateEffect.define<boolean>();

function bodyStart(state: EditorState, range: FrontmatterRange): number {
  return Math.min(range.to + 1, state.doc.length);
}

class PropertiesHeader extends WidgetType {
  constructor(readonly expanded: boolean) {
    super();
  }

  eq(other: PropertiesHeader): boolean {
    return other.expanded === this.expanded;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-frontmatter-header nodrag nowheel";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-frontmatter-toggle";
    const label = view.state.facet(editorLabels).properties;
    button.textContent = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", String(this.expanded));
    button.onclick = () => {
      const { range, expanded } = view.state.field(frontmatterState);
      if (!range) return;
      view.dispatch({
        effects: setFrontmatterExpanded.of(!expanded),
        // Never leave an editing cursor in text that was just hidden.
        ...(!expanded ? {} : { selection: { anchor: bodyStart(view.state, range) } }),
      });
      view.dom
        .querySelector<HTMLButtonElement>(".cm-frontmatter-toggle")
        ?.focus({ preventScroll: true });
    };
    // Native button focus and touch clicks work without dragging or entering canvas edit mode.
    wrap.onpointerdown = (event) => event.stopPropagation();
    wrap.ondblclick = (event) => event.stopPropagation();
    wrap.append(button);
    return wrap;
  }

  updateDOM(dom: HTMLElement): boolean {
    dom.querySelector("button")!.setAttribute("aria-expanded", String(this.expanded));
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface PropertiesState {
  range: FrontmatterRange | null;
  expanded: boolean;
  decorations: DecorationSet;
}

function properties(range: FrontmatterRange | null, expanded: boolean): PropertiesState {
  const widget = new PropertiesHeader(expanded);
  const decorations = !range
    ? Decoration.none
    : expanded
      ? Decoration.set([Decoration.widget({ widget, block: true, side: -1 }).range(range.from)])
      : Decoration.set([
          Decoration.replace({ widget, block: true, inclusive: false }).range(range.from, range.to),
        ]);
  return { range, expanded, decorations };
}

/** Local presentation only: no changes to markdown, Yjs, undo history, or plugin data. */
export const frontmatterState = StateField.define<PropertiesState>({
  create: (state) => properties(frontmatterRange(state.doc), false),
  update(value, tr) {
    const range = tr.docChanged ? frontmatterRange(tr.state.doc) : value.range;
    let expanded = range && value.range ? value.expanded : false;
    // Search, select-all, and source navigation reveal the original editable YAML.
    if (range && tr.selection?.ranges.some((r) => r.from < range.to)) expanded = true;
    for (const effect of tr.effects) if (effect.is(setFrontmatterExpanded)) expanded = effect.value;
    if (range === value.range && expanded === value.expanded) return value;
    return properties(range, expanded);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => {
      const value = view.state.field(field);
      return value.expanded ? Decoration.none : value.decorations;
    }),
  ],
});

/** Start typing in the body, even though the underlying document still starts with YAML. */
export function initialBodySelection(state: EditorState): number {
  const { range } = state.field(frontmatterState);
  return range ? bodyStart(state, range) : 0;
}
