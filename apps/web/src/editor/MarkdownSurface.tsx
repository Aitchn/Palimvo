import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { embedDepth, setEmbedRenderer } from "./embed.ts";
import { frontmatterState, initialBodySelection } from "./frontmatter.ts";
import { DEFAULT_LABELS, editorLabels, type EditorLabels } from "./labels.ts";
import { livePreview } from "./livePreview.ts";
import { markdownHost } from "./render.ts";
import { markdownSupport } from "./syntax.ts";
import { markdownHighlight } from "./theme.ts";
import { refreshWikiLinks, wikiLinks, type WikiLinkHost } from "./wikilinks.ts";

/** How markdown is parsed and shown, shared by notes and ![[embedded]] notes. */
function rendering(links: WikiLinkHost, depth: number, labels: Extension): Extension {
  return [
    // Obsidian-style YAML frontmatter (properties) is not markdown.
    yamlFrontmatter({ content: markdownSupport() }),
    markdownHighlight,
    markdownHost.of(links),
    embedDepth.of(depth),
    labels,
    frontmatterState,
    livePreview,
    wikiLinks(links),
    EditorView.lineWrapping,
  ];
}
setEmbedRenderer((links, depth, labels) => rendering(links, depth, editorLabels.of(labels)));

/** Where the text lives: a live shared Y.Text, or a plain string the caller keeps. */
export type SurfaceSource =
  | { kind: "collab"; text: Y.Text; awareness: Awareness }
  | { kind: "text"; value: string; onChange: (value: string) => void };

interface Props {
  source: SurfaceSource;
  links: WikiLinkHost;
  /** Changes whenever the vault's file list changes; used to re-resolve links. */
  paths?: readonly string[];
  /** False shows the rendered note: links still open, nothing can be typed. */
  editable: boolean;
  /** Translated text for the parts the editor draws itself. */
  labels?: EditorLabels;
  autoFocus?: boolean;
  className?: string;
  onBlur?: () => void;
  /** Hands out the editor (and null when it goes), e.g. to insert text at the cursor. */
  onView?: (view: EditorView | null) => void;
}

/** Text set from outside (another person changed the note); not echoed back through onChange. */
const external = Annotation.define<boolean>();

/** The same editing and live preview wherever markdown is shown. */
export function MarkdownSurface({
  source,
  links,
  paths,
  editable,
  labels = DEFAULT_LABELS,
  autoFocus,
  className,
  onBlur,
  onView,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const editableSlot = useRef(new Compartment());
  const labelSlot = useRef(new Compartment());
  const editableSeen = useRef<boolean | undefined>(undefined);
  /** Where the cursor was when the shared text was swapped for another copy of the same note. */
  const carriedSelection = useRef<{
    text: string;
    anchor: number;
    head: number;
    focused: boolean;
  } | null>(null);
  // The editor is created once per shared text; callbacks read the latest props through this ref.
  const latest = useRef({ links, source, labels, onBlur, onView });
  latest.current = { links, source, labels, onBlur, onView };

  const sharedText = source.kind === "collab" ? source.text : null;
  const awareness = source.kind === "collab" ? source.awareness : null;

  useEffect(() => {
    if (!host.current) return;
    const linkHost: WikiLinkHost = {
      resolve: (target) => latest.current.links.resolve(target),
      paths: () => latest.current.links.paths(),
      open: (target) => latest.current.links.open(target),
      fileUrl: (path) => latest.current.links.fileUrl?.(path) ?? "",
      readText: (path) =>
        latest.current.links.readText?.(path) ?? Promise.reject(new Error("no vault")),
    };
    const sync: Extension =
      sharedText && awareness
        ? // Undo goes through Yjs so it only reverts this user's own edits, never someone else's.
          [
            yCollab(sharedText, awareness, { undoManager: new Y.UndoManager(sharedText) }),
            keymap.of(yUndoManagerKeymap),
          ]
        : [
            history(),
            keymap.of(historyKeymap),
            EditorView.updateListener.of((u) => {
              const s = latest.current.source;
              if (
                u.docChanged &&
                s.kind === "text" &&
                !u.transactions.some((t) => t.annotation(external))
              ) {
                s.onChange(u.state.doc.toString());
              }
            }),
          ];
    const initial = sharedText ? sharedText.toString() : source.kind === "text" ? source.value : "";
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          highlightSpecialChars(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          rendering(linkHost, 0, labelSlot.current.of(editorLabels.of(latest.current.labels))),
          editableSlot.current.of(editableExtensions(editable)),
          EditorView.domEventHandlers({
            blur: (event, v) => {
              // Properties controls are part of the editor.
              if (event.relatedTarget instanceof Node && v.dom.contains(event.relatedTarget))
                return;
              latest.current.onBlur?.();
            },
          }),
          sync,
        ],
      }),
    });
    // Only for the same text: another note (or a changed one) starts at the top as usual.
    const carried = carriedSelection.current?.text === initial ? carriedSelection.current : null;
    carriedSelection.current = null;
    view.dispatch({
      selection: carried
        ? { anchor: carried.anchor, head: carried.head }
        : { anchor: initialBodySelection(view.state) },
      annotations: Transaction.addToHistory.of(false),
    });
    viewRef.current = view;
    latest.current.onView?.(view);
    if (autoFocus || carried?.focused) view.focus();
    return () => {
      const { anchor, head } = view.state.selection.main;
      carriedSelection.current = {
        text: view.state.doc.toString(),
        anchor,
        head,
        focused: view.hasFocus,
      };
      latest.current.onView?.(null);
      view.destroy();
      viewRef.current = undefined;
    };
    // The editor is rebuilt only when the shared text changes; other props are applied below.
  }, [sharedText, awareness]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: editableSlot.current.reconfigure(editableExtensions(editable)) });
    // Switching from reading to editing puts the cursor in the text; the first render does not
    // (that is `autoFocus`), so keyboard navigation in the file tree is not interrupted.
    if (editable && editableSeen.current !== undefined) view.focus();
    editableSeen.current = editable;
  }, [editable]);

  // A plain-text source changed elsewhere (another tab, an AI): apply it right away, even while
  // typing, so the next keystroke never sends back a stale copy. Only the changed span is replaced,
  // which keeps the cursor where it was.
  const value = source.kind === "text" ? source.value : null;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === null) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    let start = 0;
    while (start < current.length && start < value.length && current[start] === value[start])
      start++;
    let end = 0;
    while (
      end < current.length - start &&
      end < value.length - start &&
      current[current.length - 1 - end] === value[value.length - 1 - end]
    ) {
      end++;
    }
    view.dispatch({
      changes: {
        from: start,
        to: current.length - end,
        insert: value.slice(start, value.length - end),
      },
      // Someone else's edit: never part of this user's undo history.
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshWikiLinks.of(null) });
  }, [paths]);

  // Switching language redraws the widgets that carry text.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: labelSlot.current.reconfigure(editorLabels.of(labels)) });
  }, [labels]);

  return <div className={className} ref={host} />;
}

function editableExtensions(editable: boolean): Extension {
  return [EditorView.editable.of(editable), EditorState.readOnly.of(!editable)];
}
