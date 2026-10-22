// @vitest-environment jsdom
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownSurface, type SurfaceSource } from "./MarkdownSurface.tsx";
import { frontmatterState } from "./frontmatter.ts";

const yaml = "---\nstatus: accepted\nrelated: '[[Other]]'\ntags: [one, two]\n---";
const note = yaml + "\n# Body\n[[Other]]\n";
const links = { paths: () => ["Other.md"], resolve: () => "Other.md", open: vi.fn() };
let host: HTMLDivElement;
let root: Root;
const resources: { destroy: () => void }[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no text layout; these tests exercise real editor transactions and DOM controls.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resources.splice(0).forEach((resource) => resource.destroy());
  vi.unstubAllGlobals();
});

function render(source: SurfaceSource, editable = true, onBlur = vi.fn()) {
  act(() =>
    root.render(
      <MarkdownSurface
        className="editor-body"
        source={source}
        links={links}
        editable={editable}
        onBlur={onBlur}
      />,
    ),
  );
  return EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
}
const ytext = (doc: Y.Doc) => doc.getText("markdown");
function button() {
  return host.querySelector<HTMLButtonElement>(".cm-frontmatter-toggle")!;
}
function shared(value = note) {
  const doc = new Y.Doc();
  ytext(doc).insert(0, value);
  const awareness = new Awareness(doc);
  resources.push(awareness, doc);
  return { kind: "collab" as const, text: ytext(doc), doc, awareness };
}

describe("MarkdownSurface properties controls", () => {
  it.each([true, false])(
    "defaults collapsed, keeps a focused button through repeated clicks (editable=%s)",
    (editable) => {
      const onChange = vi.fn();
      const view = render({ kind: "text", value: note, onChange }, editable);
      expect(button().textContent).toBe("Properties");
      expect(button().getAttribute("aria-expanded")).toBe("false");
      expect(host.querySelector(".cm-content")!.textContent).not.toContain("status:");
      for (let n = 0; n < 6; n++) {
        act(() => button().click());
        expect(button().getAttribute("aria-expanded")).toBe(String(n % 2 === 0));
        expect(document.activeElement).toBe(button());
        expect(view.state.doc.toString()).toBe(note);
      }
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("starts typing in the body and undo restores it without changing YAML", () => {
    const onChange = vi.fn();
    const view = render({ kind: "text", value: note, onChange });
    expect(view.state.selection.main.head).toBe(yaml.length + 1);
    act(() =>
      view.dispatch({ changes: { from: view.state.selection.main.head, insert: "Typed " } }),
    );
    expect(onChange).toHaveBeenLastCalledWith(yaml + "\nTyped # Body\n[[Other]]\n");
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe(note);
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps source YAML raw while preserving body wikilinks", () => {
    const view = render({ kind: "text", value: note, onChange: vi.fn() }, false);
    act(() => button().click());
    expect(host.querySelector(".cm-content")!.textContent).toContain("related: '[[Other]]'");
    expect(host.querySelectorAll(".cm-wikilink")).toHaveLength(1);
    expect(view.state.doc.toString()).toBe(note);
  });

  it("keeps canvas edit mode when the properties button gains focus", () => {
    const onBlur = vi.fn();
    const view = render({ kind: "text", value: note, onChange: vi.fn() }, true, onBlur);
    act(() => {
      view.focus();
      button().focus();
      button().click();
    });
    expect(onBlur).not.toHaveBeenCalled();
    const doubleClick = new MouseEvent("dblclick", { bubbles: true });
    const outer = vi.fn();
    host.addEventListener("dblclick", outer);
    button().dispatchEvent(doubleClick);
    expect(outer).not.toHaveBeenCalled();
    expect(button().closest(".nodrag.nowheel")).not.toBeNull();
  });

  it("collapses when switching notes and applies external text updates without echoing", () => {
    const first = shared();
    render(first);
    act(() => button().click());
    const second = shared(note.replace("accepted", "draft"));
    const view = render(second);
    expect(view.state.doc.toString()).toContain("status: draft");
    expect(button().getAttribute("aria-expanded")).toBe("false");

    const onChange = vi.fn();
    render({ kind: "text", value: note, onChange });
    act(() => button().click());
    const textView = render({ kind: "text", value: note + "Remote body", onChange });
    expect(textView.state.doc.toString()).toBe(note + "Remote body");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not synchronize UI toggles or normalize the shared YAML bytes", () => {
    const source = shared(note.replaceAll("\n", "\r\n"));
    const originalBytes = ytext(source.doc).toString();
    const view = render(source);
    const updates = vi.fn();
    source.doc.on("update", updates);
    act(() => {
      button().click();
      button().click();
    });
    expect(updates).not.toHaveBeenCalled();
    expect(ytext(source.doc).toString()).toBe(originalBytes);
    expect(view.state.field(frontmatterState).expanded).toBe(false);
  });

  it("merges remote YAML changes while collapsed", () => {
    const source = shared();
    const view = render(source);
    const remote = new Y.Doc();
    resources.push(remote);
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(source.doc));
    const text = ytext(remote);
    remote.transact(() => {
      const from = text.toString().indexOf("accepted");
      text.delete(from, "accepted".length);
      text.insert(from, "draft");
    });
    act(() => Y.applyUpdate(source.doc, Y.encodeStateAsUpdate(remote), "remote-provider"));
    expect(view.state.doc.toString()).toContain("status: draft");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    act(() => button().click());
    expect(host.querySelector(".cm-content")!.textContent).toContain("status: draft");
  });

  it("leaves remote edits intact when undoing local typing with the Yjs keymap", () => {
    const source = shared();
    const view = render(source);
    const remote = new Y.Doc();
    resources.push(remote);
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(source.doc));
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "Local body" } }));
    const text = ytext(remote);
    text.insert(text.toString().indexOf("accepted"), "remote-");
    act(() => Y.applyUpdate(source.doc, Y.encodeStateAsUpdate(remote), "remote-provider"));
    act(() => {
      button().click();
      button().click();
      view.focus();
    });
    act(() =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true }),
      ),
    );
    expect(ytext(source.doc).toString()).toBe(note.replace("accepted", "remote-accepted"));
    expect(view.state.field(frontmatterState).range).not.toBeNull();
  });
});
