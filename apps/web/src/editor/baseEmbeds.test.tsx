import { baseFile, parseBase, queryBase } from "@palimvo/core";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRoutes, renderWithProviders, type RecordedCall } from "../test/render.tsx";
import { NoteEditor } from "./NoteEditor.tsx";

const BASE =
  "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - status\n";
const NOTES: Record<string, string> = {
  "Tasks/Alpha.md": "---\nstatus: open\n---\n",
  "Tasks/Beta.md": "---\nstatus: done\n---\n",
};
const PLAN = "# Plan\n\n![[Tasks.base]]\n\nafter\n";
const BLOCK =
  "# Plan\n\n```base\nviews:\n  - type: table\n    name: Inline\n    order:\n      - file.name\n```\n\nafter\n";

function view(): EditorView {
  return EditorView.findFromDOM(document.querySelector(".cm-content")!)!;
}

async function open(content: string, readOnly = false) {
  const server = mockRoutes({
    "GET /api/vaults/v/files/Plan.md": () =>
      Response.json({ path: "Plan.md", content, mtime: 1, version: "v1" }),
    "PUT /api/vaults/v/files/Plan.md": () =>
      Response.json({ path: "Plan.md", version: "v2", mtime: 2 }),
    "POST /api/vaults/v/bases/query": (call: RecordedCall) => {
      const q = call.body as { path?: string; source?: string; view?: string };
      const files = Object.entries(NOTES).map(([path, text]) =>
        baseFile({ path, content: text, mtime: 1 }, []),
      );
      return Response.json({
        ...queryBase(parseBase(q.path ? BASE : q.source!), files),
        version: "b1",
      });
    },
    "GET /api/vaults/v/files/Tasks.base": () =>
      Response.json({ path: "Tasks.base", content: BASE, mtime: 1, version: "b1" }),
  });
  const onOpen = vi.fn();
  await renderWithProviders(
    <NoteEditor
      vault="v"
      path="Plan.md"
      paths={["Plan.md", "Tasks.base", "Tasks/Alpha.md", "Tasks/Beta.md"]}
      onOpen={onOpen}
      onCreate={vi.fn()}
      readOnly={readOnly}
    />,
  );
  await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
  return { ...server, onOpen };
}

beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  localStorage.clear();
});

describe("databases inside a note", () => {
  it("draws a ![[name.base]] line as the database itself", async () => {
    const { calls } = await open(PLAN);
    const embed = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".cm-base-embed");
      expect(el).not.toBeNull();
      return el!;
    });
    const table = await within(embed).findByRole("table");
    expect(within(table).getByText("Alpha")).toBeInTheDocument();
    expect(within(table).getByText("done")).toBeInTheDocument();
    // The source line is replaced, not shown twice.
    expect(document.querySelector(".cm-content")!.textContent).not.toContain("![[Tasks.base]]");
    const query = calls.find((c) => c.url === "/api/vaults/v/bases/query")!;
    expect(query.body).toMatchObject({ path: "Tasks.base" });
  });

  it("draws a ```base block from its YAML, with the note as `this`", async () => {
    const { calls } = await open(BLOCK);
    const embed = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".cm-base-embed");
      expect(el).not.toBeNull();
      return el!;
    });
    await within(embed).findByRole("table");
    const query = calls.find((c) => c.url === "/api/vaults/v/bases/query")!;
    expect(query.body).toMatchObject({ thisPath: "Plan.md" });
    expect((query.body as { source: string }).source).toContain("name: Inline");
    expect(document.querySelector(".cm-codeblock")).toBeNull();
  });

  it("writes changed settings back into the block of the note", async () => {
    const user = userEvent.setup();
    await open(BLOCK);
    const embed = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".cm-base-embed");
      expect(el).not.toBeNull();
      return el!;
    });
    await within(embed).findByRole("table");
    await user.selectOptions(within(embed).getByRole("combobox", { name: "Display as" }), "cards");
    await waitFor(() => expect(view().state.doc.toString()).toContain("type: cards"));
    expect(view().state.doc.toString()).toMatch(/```base\n[\s\S]*type: cards[\s\S]*\n```\n\nafter/);
  });

  it("changes the block that was used when two blocks have the same YAML", async () => {
    const block =
      "```base\nviews:\n  - type: table\n    name: Inline\n    order:\n      - file.name\n```";
    const user = userEvent.setup();
    await open(`# Plan\n\n${block}\n\nmiddle\n\n${block}\n`);
    await waitFor(() => expect(document.querySelectorAll(".cm-base-embed")).toHaveLength(2));
    const second = document.querySelectorAll<HTMLElement>(".cm-base-embed")[1]!;
    await within(second).findByRole("table");
    await user.selectOptions(within(second).getByRole("combobox", { name: "Display as" }), "cards");
    await waitFor(() => expect(view().state.doc.toString()).toContain("type: cards"));
    const doc = view().state.doc.toString();
    expect(doc.match(/type: cards/g)).toHaveLength(1);
    expect(doc.indexOf("type: cards")).toBeGreaterThan(doc.indexOf("middle"));
  });

  it("keeps the source visible while the cursor is on it", async () => {
    await open(PLAN);
    await waitFor(() => expect(document.querySelector(".cm-base-embed")).not.toBeNull());
    act(() => view().dispatch({ selection: { anchor: PLAN.indexOf("![[Tasks.base]]") + 3 } }));
    await waitFor(() =>
      expect(document.querySelector(".cm-content")!.textContent).toContain("![[Tasks.base]]"),
    );
    expect(document.querySelector(".cm-base-embed")).not.toBeNull();
  });

  it("is read-only in a note the person cannot edit", async () => {
    await open(BLOCK, true);
    const embed = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".cm-base-embed");
      expect(el).not.toBeNull();
      return el!;
    });
    await within(embed).findByRole("table");
    expect(within(embed).queryByRole("combobox", { name: "Display as" })).toBeNull();
    expect(within(embed).queryByRole("button", { name: "New note" })).toBeNull();
  });

  it("says when the named database does not exist", async () => {
    await open("# Plan\n\n![[Missing.base]]\n");
    expect(await screen.findByText("Database Missing.base was not found.")).toBeInTheDocument();
  });
});
