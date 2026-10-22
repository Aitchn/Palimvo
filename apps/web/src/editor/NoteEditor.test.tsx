import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRoutes, renderWithProviders, type RecordedCall } from "../test/render.tsx";
import { NoteEditor } from "./NoteEditor.tsx";
import { SAVE_DELAY_MS } from "./useNoteSession.ts";

const URL = "/api/vaults/v/files/Plan.md";
const note = (content: string, version = "v1") =>
  Response.json({ path: "Plan.md", content, mtime: 1, version });

function view(): EditorView {
  return EditorView.findFromDOM(document.querySelector(".cm-content")!)!;
}

async function open(
  extra: Record<string, (call: RecordedCall) => Response> = {},
  readOnly = false,
) {
  const server = mockRoutes({
    [`GET ${URL}`]: () => note("# Plan\nhello"),
    [`PUT ${URL}`]: () => Response.json({ path: "Plan.md", version: "v2", mtime: 2 }),
    ...extra,
  });
  const onOpen = vi.fn();
  const onCreate = vi.fn();
  await renderWithProviders(
    <NoteEditor
      vault="v"
      path="Plan.md"
      paths={["Plan.md", "Other.md"]}
      onOpen={onOpen}
      onCreate={onCreate}
      readOnly={readOnly}
    />,
  );
  await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
  return { ...server, onOpen, onCreate };
}

const puts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "PUT");

beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("NoteEditor", () => {
  it("shows the note and saves typing after a pause, with the version it read", async () => {
    const { calls } = await open();
    expect(view().state.doc.toString()).toBe("# Plan\nhello");
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => view().dispatch({ changes: { from: view().state.doc.length, insert: " world" } }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    });
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]!.body).toEqual({ content: "# Plan\nhello world", baseVersion: "v1" });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  it("offers a conflict choice instead of overwriting a newer version", async () => {
    const { calls, handlers } = await open({
      [`PUT ${URL}`]: () =>
        Response.json({ code: "version_conflict", message: "changed" }, { status: 409 }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => view().dispatch({ changes: { from: 0, insert: "mine " } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    });
    vi.useRealTimers();
    expect(screen.getByRole("alert")).toHaveTextContent("Someone else saved this note first");
    // No further attempts while the conflict stands.
    expect(puts(calls)).toHaveLength(1);

    handlers[`GET ${URL}`] = () => note("# Plan\ntheirs", "v9");
    await userEvent.click(screen.getByRole("button", { name: "Use their version" }));
    await waitFor(() => expect(view().state.doc.toString()).toBe("# Plan\ntheirs"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps my text on request by saving over the newer version", async () => {
    let first = true;
    const { calls, handlers } = await open({
      [`PUT ${URL}`]: () =>
        first
          ? ((first = false),
            Response.json({ code: "version_conflict", message: "changed" }, { status: 409 }))
          : Response.json({ path: "Plan.md", version: "v10", mtime: 3 }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => view().dispatch({ changes: { from: 0, insert: "mine " } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    });
    vi.useRealTimers();
    handlers[`GET ${URL}`] = () => note("# Plan\ntheirs", "v9");
    await userEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1]!.body).toEqual({ content: "mine # Plan\nhello", baseVersion: "v9" });
    await screen.findByText("Saved");
  });

  it("restores text that was typed but never sent", async () => {
    localStorage.setItem("palimvo.unsent:v:Plan.md", "# Plan\nunsent words");
    await open();
    expect(view().state.doc.toString()).toBe("# Plan\nunsent words");
    expect(screen.getByText("Unsent text from earlier was restored")).toBeInTheDocument();
  });

  it("keeps the text and retries when the server cannot be reached", async () => {
    let down = true;
    const { calls } = await open({
      [`PUT ${URL}`]: () =>
        down ? Response.error() : Response.json({ path: "Plan.md", version: "v2", mtime: 2 }),
    });
    // Response.error() resolves with a network-error response, which the client reports as a failure.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => view().dispatch({ changes: { from: 0, insert: "x" } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    });
    expect(screen.getByText("Offline, will retry")).toBeInTheDocument();
    expect(localStorage.getItem("palimvo.unsent:v:Plan.md")).toBe("x# Plan\nhello");
    down = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(puts(calls).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  it("switches to a reading view where nothing can be typed", async () => {
    await open();
    expect(view().state.facet(EditorView.editable)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(view().state.facet(EditorView.editable)).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(view().state.facet(EditorView.editable)).toBe(true);
  });

  it("is view-only for people who may not edit", async () => {
    await open({}, true);
    expect(view().state.facet(EditorView.editable)).toBe(false);
    expect(screen.getByText("View only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read" })).toBeNull();
  });

  it("opens a link to an existing note, and asks to create a missing one", async () => {
    const { onOpen, onCreate } = await open(
      { [`GET ${URL}`]: () => note("[[Other]] and [[Missing]]") },
      true,
    );
    const links = [...document.querySelectorAll<HTMLElement>(".cm-wikilink-rendered")];
    expect(links).toHaveLength(2);
    // Rendered links open on a click.
    act(() => {
      links[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(onOpen).toHaveBeenCalledWith("Other.md");
    act(() => {
      links[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(onCreate).toHaveBeenCalledWith("Missing");
  });

  it("shows an error with a retry when the note cannot be read", async () => {
    mockRoutes({});
    await renderWithProviders(
      <NoteEditor vault="v" path="Gone.md" paths={[]} onOpen={vi.fn()} onCreate={vi.fn()} />,
    );
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
