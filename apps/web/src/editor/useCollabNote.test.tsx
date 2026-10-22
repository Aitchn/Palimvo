import { act, renderHook, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
import { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProvider } from "../test/fakeProvider.ts";
import { createI18n } from "../i18n/index.ts";
import { GONE, STALE_LINEAGE, useCollabNote } from "./useCollabNote.ts";

vi.mock("y-websocket", async () => ({
  WebsocketProvider: (await import("../test/fakeProvider.ts")).FakeProvider,
}));

let wrapper: ({ children }: { children: ReactNode }) => ReactNode;
beforeEach(async () => {
  FakeProvider.all = [];
  const i18n = await createI18n("en");
  wrapper = ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
});
afterEach(() => vi.unstubAllGlobals());

const current = () => FakeProvider.all.at(-1)!;

describe("useCollabNote", () => {
  it("waits for the server's document, then hands the editor a live source", async () => {
    const { result } = renderHook(() => useCollabNote("v", "Plan.md"), { wrapper });
    expect(result.current.status).toBe("loading");
    expect(result.current.source).toBeNull();
    expect(current().room).toBe(encodeURIComponent("v/Plan.md"));
    expect(current().params).toMatchObject({ vault: "v", path: "Plan.md" });

    act(() => current().serve());
    expect(result.current.status).toBe("saved");
    expect(result.current.source).toMatchObject({ kind: "collab" });
    const source = result.current.source as { text: Y.Text };
    expect(source.text.toString()).toBe("hello");
  });

  it("names the history it holds when it asks again, so the server can refuse an older copy", () => {
    renderHook(() => useCollabNote("v", "Plan.md"), { wrapper });
    act(() => current().serve("lineage-7"));
    expect(current().params.lineage).toBe("lineage-7");
  });

  it("counts the people and AIs with the note open", () => {
    const { result } = renderHook(() => useCollabNote("v", "Plan.md"), { wrapper });
    act(() => current().serve());
    expect(result.current.peers).toBe(1);
    act(() => {
      const other = new Awareness(new (current().doc.constructor as typeof Y.Doc)());
      other.setLocalStateField("user", { name: "Claude Code" });
      // Another client announces itself through the server.
      current().awareness.states.set(other.clientID, { user: { name: "Claude Code" } });
      current().awareness.emit("change", [{ added: [other.clientID], updated: [], removed: [] }]);
    });
    expect(result.current.peers).toBe(2);
  });

  it("keeps text typed while offline, warns about leaving, and clears the warning on return", () => {
    const { result } = renderHook(() => useCollabNote("v", "Plan.md"), { wrapper });
    act(() => current().serve());
    act(() => current().drop());
    expect(result.current.status).toBe("offline");

    act(() => (result.current.source as { text: Y.Text }).text.insert(0, "typed offline "));
    expect(result.current.unsent).toBe(true);
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);

    act(() => current().serve());
    expect(result.current.unsent).toBe(false);
    expect(result.current.status).toBe("saved");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("does not count the server's own updates as unsent text", () => {
    const { result } = renderHook(() => useCollabNote("v", "Plan.md"), { wrapper });
    act(() => current().serve());
    act(() => current().drop());
    act(() => {
      const text = (result.current.source as { text: Y.Text }).text;
      current().doc.transact(() => text.insert(0, "from server "), current());
    });
    expect(result.current.unsent).toBe(false);
  });

  it("shows 'not found' when the note was deleted or moved", () => {
    const { result } = renderHook(() => useCollabNote("v", "Plan.md"), { wrapper });
    act(() => current().serve());
    act(() => current().emit("connection-close", { code: GONE }));
    expect(result.current.status).toBe("error");
    expect(result.current.source).toBeNull();
    expect(result.current.error).toMatchObject({ code: "not_found" });
  });

  it("starts over from the server's copy when its history is newer", async () => {
    const { result } = renderHook(() => useCollabNote("v", "Plan.md"), { wrapper });
    act(() => current().serve());
    const first = current();
    act(() => current().emit("connection-close", { code: STALE_LINEAGE }));
    await waitFor(() => expect(FakeProvider.all).toHaveLength(2));
    expect(first.destroyed).toBe(true);
    act(() => current().serve("L2", "rewritten"));
    expect(result.current.notice).toBe("reloaded");
    expect((result.current.source as { text: Y.Text }).text.toString()).toBe("rewritten");
  });

  it("saves text typed offline as its own note when the server's history is newer", async () => {
    const sent: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      sent.push({ url, method: init?.method, body: init?.body as string });
      return Response.json({ path: "x", version: "v1", mtime: 1 });
    });
    const { result } = renderHook(() => useCollabNote("v", "Plan.md"), { wrapper });
    act(() => current().serve());
    act(() => current().drop());
    act(() => (result.current.source as { text: Y.Text }).text.insert(5, " + offline"));
    act(() => current().emit("connection-close", { code: STALE_LINEAGE }));
    await waitFor(() => expect(FakeProvider.all).toHaveLength(2));
    expect(result.current.notice).toBe("savedCopy");
    const put = sent.find((c) => c.method === "PUT")!;
    expect(decodeURIComponent(put.url)).toMatch(
      /^\/api\/vaults\/v\/files\/Plan \(offline \d{8} \d{4}\)\.md$/,
    );
    expect(JSON.parse(put.body!)).toEqual({ content: "hello + offline", baseVersion: null });
  });

  it("disconnects when the note is closed", () => {
    const { unmount } = renderHook(() => useCollabNote("v", "Plan.md"), { wrapper });
    const provider = current();
    unmount();
    expect(provider.destroyed).toBe(true);
  });
});
