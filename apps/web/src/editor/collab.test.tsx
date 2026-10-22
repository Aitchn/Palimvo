// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guestUser, presenceColor, presenceFor } from "../collab/presence.ts";
import { MarkdownSurface } from "./MarkdownSurface.tsx";

const links = { paths: () => [], resolve: () => undefined, open: vi.fn() };

interface Peer {
  doc: Y.Doc;
  awareness: Awareness;
  host: HTMLDivElement;
  root: Root;
  view: () => EditorView;
}
const peers: Peer[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  for (const p of peers.splice(0)) {
    act(() => p.root.unmount());
    p.host.remove();
    p.awareness.destroy();
    p.doc.destroy();
  }
  vi.unstubAllGlobals();
});

/** An editor on its own Y.Doc, standing in for one browser tab. */
function openTab(name: string): Peer {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", presenceFor({ kind: "human", id: name, name }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <MarkdownSurface
        className="editor-body"
        source={{ kind: "collab", text: doc.getText("markdown"), awareness }}
        links={links}
        editable
      />,
    ),
  );
  const peer = {
    doc,
    awareness,
    host,
    root,
    view: () => EditorView.findFromDOM(host.querySelector(".cm-content")!)!,
  };
  peers.push(peer);
  return peer;
}

/** What the server does: relays document updates and awareness between tabs. */
function connect(a: Peer, b: Peer): void {
  const relay = (from: Peer, to: Peer) => {
    from.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== to) act(() => Y.applyUpdate(to.doc, update, from));
    });
    from.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = [...added, ...updated, ...removed];
        act(() =>
          applyAwarenessUpdate(to.awareness, encodeAwarenessUpdate(from.awareness, changed), from),
        );
      },
    );
  };
  relay(a, b);
  relay(b, a);
  act(() => Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), a));
}

describe("two tabs on one note", () => {
  it("merge what both type at the same time", () => {
    const a = openTab("Ada");
    const b = openTab("Bo");
    act(() => a.doc.getText("markdown").insert(0, "one\n\ntwo\n"));
    connect(a, b);
    act(() => a.view().dispatch({ changes: { from: 0, insert: "A: " } }));
    act(() =>
      b.view().dispatch({ changes: { from: b.view().state.doc.length, insert: "B: end" } }),
    );
    const merged = "A: one\n\ntwo\nB: end";
    expect(a.doc.getText("markdown").toString()).toBe(merged);
    expect(b.doc.getText("markdown").toString()).toBe(merged);
    expect(a.view().state.doc.toString()).toBe(merged);
    expect(b.view().state.doc.toString()).toBe(merged);
  });

  it("shows the other tab's cursor with their name", () => {
    const a = openTab("Ada");
    const b = openTab("Claude Code");
    act(() => a.doc.getText("markdown").insert(0, "hello world"));
    connect(a, b);
    act(() => b.view().focus());
    act(() => b.view().dispatch({ selection: { anchor: 5 } }));
    const label = a.host.querySelector(".cm-ySelectionInfo");
    expect(label?.textContent).toBe("Claude Code");
    expect(a.host.querySelector(".cm-ySelectionCaret")).not.toBeNull();
  });

  it("undoes only the local edit", () => {
    const a = openTab("Ada");
    const b = openTab("Bo");
    connect(a, b);
    act(() => a.view().dispatch({ changes: { from: 0, insert: "mine " } }));
    act(() =>
      b.view().dispatch({ changes: { from: b.view().state.doc.length, insert: "theirs" } }),
    );
    act(() => a.view().focus());
    act(() =>
      a
        .view()
        .contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true }),
        ),
    );
    expect(a.doc.getText("markdown").toString()).toBe("theirs");
  });
});

describe("presence identity", () => {
  it("gives the same colour to the same author every time, and AIs show their client name", () => {
    expect(presenceColor("ai:claude-code")).toBe(presenceColor("ai:claude-code"));
    const ai = presenceFor({ kind: "ai", id: "claude-code", name: "Claude Code" });
    expect(ai).toMatchObject({ name: "Claude Code", kind: "ai" });
    expect(ai.colorLight).toBe(`${ai.color}33`);
  });

  it("keeps a guest name for the browser", () => {
    localStorage.clear();
    const first = guestUser((n) => `Guest ${n}`);
    expect(first.name).toMatch(/^Guest \d{4}$/);
    expect(guestUser(() => "other").name).toBe(first.name);
  });
});
