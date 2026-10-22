import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_MS } from "../files/useVaultTree.ts";
import { initTheme } from "../theme/theme.ts";
import { mockMatchMedia, mockRoutes, renderRoute, type RecordedCall } from "../test/render.tsx";

// These tests are about the file tree and tabs, which have no live server here: notes open over HTTP.
vi.mock("../editor/useCollabNote.ts", async () => {
  const { useNoteSession } = await import("../editor/useNoteSession.ts");
  return { useCollabNote: useNoteSession };
});

const FILES = {
  tree: [
    {
      name: "Projects",
      path: "Projects",
      type: "folder",
      children: [
        { name: "Plan.md", path: "Projects/Plan.md", type: "file", kind: "markdown" },
        { name: "Empty", path: "Projects/Empty", type: "folder", children: [] },
      ],
    },
    { name: "Board.canvas", path: "Board.canvas", type: "file", kind: "canvas" },
    { name: "Welcome.md", path: "Welcome.md", type: "file", kind: "markdown" },
  ],
};

const file = (path: string, content = "") =>
  Response.json({ path, content, mtime: 1, version: "abc" });

/** A server with the sample vault; returns the recorded calls. */
function server(extra: Record<string, (call: RecordedCall) => Response | Promise<Response>> = {}) {
  return mockRoutes({
    "GET /api/vaults": () =>
      Response.json({
        vaults: [
          { id: "sample", name: "sample" },
          { id: "other", name: "other" },
        ],
      }),
    "GET /api/vaults/sample/files": () => Response.json(FILES, { headers: { ETag: '"t1"' } }),
    "GET /api/vaults/sample/files/Welcome.md": () => file("Welcome.md", "Hello **world**"),
    "GET /api/vaults/sample/files/Projects/Plan.md": () => file("Projects/Plan.md", "Plan text"),
    "GET /api/vaults/sample/files/Board.canvas": () => file("Board.canvas", "{}"),
    "PUT /api/vaults/sample/files/Untitled.md": () =>
      Response.json({ path: "Untitled.md", version: "v", mtime: 1 }),
    "POST /api/vaults/sample/move": () => Response.json({}),
    "DELETE /api/vaults/sample/files/Welcome.md": () => new Response(null, { status: 204 }),
    ...extra,
  });
}

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

const treeitem = (name: string) => screen.findByRole("treeitem", { name: new RegExp(`^${name}`) });

describe("file tree", () => {
  it("opens and closes folders and remembers them", async () => {
    server();
    const user = userEvent.setup();
    const first = await renderRoute("/v/sample");
    await user.click(await treeitem("Projects"));
    expect(await treeitem("Plan.md")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /^Projects/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    first.unmount();

    await renderRoute("/v/sample");
    expect(await treeitem("Plan.md")).toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: /^Projects/ }));
    expect(screen.queryByRole("treeitem", { name: /^Plan.md/ })).toBeNull();
  });

  it("opens a file in a tab and shows its text", async () => {
    server();
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample");
    await user.click(await treeitem("Welcome.md"));
    expect(router.state.location.pathname).toBe("/v/sample/Welcome.md");
    expect(await screen.findByRole("article", { name: "Welcome.md" })).toHaveTextContent(
      "Hello **world**",
    );
    const tabs = screen.getByRole("tablist", { name: "Open files" });
    expect(within(tabs).getByRole("tab", { name: "Welcome" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("treeitem", { name: /^Welcome.md/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("follows the arrow keys, Enter and Left/Right", async () => {
    server();
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample");
    await treeitem("Projects");
    await user.click(screen.getByRole("tree", { name: "File tree" }));
    await user.keyboard("{Home}{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tree")).toHaveAttribute(
      "aria-activedescendant",
      expect.stringMatching(/tree-row-1$/),
    );
    await user.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe("/v/sample/Projects/Plan.md");
    await user.keyboard("{ArrowLeft}"); // from a file: to its folder
    expect(screen.getByRole("tree")).toHaveAttribute(
      "aria-activedescendant",
      expect.stringMatching(/tree-row-0$/),
    );
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("treeitem", { name: /^Projects/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("only draws the rows near the viewport", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({
      name: `n${i}.md`,
      path: `n${i}.md`,
      type: "file",
      kind: "markdown",
    }));
    server({ "GET /api/vaults/sample/files": () => Response.json({ tree: big }) });
    await renderRoute("/v/sample");
    await treeitem("n0.md");
    const rows = screen.getAllByRole("treeitem");
    expect(rows.length).toBeLessThan(80);
    expect(screen.getByRole("tree")).toHaveStyle({ height: `${5000 * 30}px` });
    expect(rows[0]).toHaveAttribute("aria-setsize", "5000");
  });

  it("tells an empty vault how to start", async () => {
    server({ "GET /api/vaults/sample/files": () => Response.json({ tree: [] }) });
    await renderRoute("/v/sample");
    expect(await screen.findByText("This vault has no files yet.")).toBeInTheDocument();
  });

  it("picks up files that appear on the server by polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let tag = '"t1"';
    let extra = false;
    const api = server({
      "GET /api/vaults/sample/files": (call) => {
        if (call.headers["If-None-Match"] === tag) return new Response(null, { status: 304 });
        return Response.json(
          {
            tree: extra
              ? [...FILES.tree, { name: "New.md", path: "New.md", type: "file", kind: "markdown" }]
              : FILES.tree,
          },
          { headers: { ETag: tag } },
        );
      },
    });
    await renderRoute("/v/sample");
    await treeitem("Welcome.md");
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS + 50));
    expect(screen.queryByRole("treeitem", { name: /^New.md/ })).toBeNull();
    expect(api.calls.filter((c) => c.url.endsWith("/files")).at(-1)?.headers["If-None-Match"]).toBe(
      '"t1"',
    );
    extra = true;
    tag = '"t2"';
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS + 50));
    expect(await treeitem("New.md")).toBeInTheDocument();
  });
});

describe("deep links and tabs", () => {
  it("opens the address it was given, reveals the file and adds a tab", async () => {
    server();
    await renderRoute("/v/sample/Projects/Plan.md");
    expect(await screen.findByText("Plan text")).toBeInTheDocument();
    expect(await treeitem("Plan.md")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("tab", { name: "Plan" })).toBeInTheDocument();
  });

  it("says so when the address names nothing", async () => {
    server();
    await renderRoute("/v/sample/Nope/Missing.md");
    expect(await screen.findByRole("heading", { name: "File not found" })).toBeInTheDocument();
  });

  it("switches between tabs and closing the active one shows its neighbour", async () => {
    server();
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample/Welcome.md");
    await screen.findByRole("article", { name: "Welcome.md" });
    await user.click(await treeitem("Board.canvas"));
    await screen.findByRole("article", { name: "Board.canvas" });
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    await user.click(screen.getByRole("tab", { name: "Welcome" }));
    expect(router.state.location.pathname).toBe("/v/sample/Welcome.md");
    await user.click(screen.getByRole("button", { name: "Close: Welcome" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/v/sample/Board.canvas"));
    await user.click(screen.getByRole("button", { name: "Close: Board.canvas" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/v/sample"));
    expect(screen.getByRole("main")).toHaveTextContent("No file open");
  });

  it("brings the tabs back after a reload", async () => {
    server();
    const first = await renderRoute("/v/sample/Welcome.md");
    await screen.findByRole("tab", { name: "Welcome" });
    first.unmount();
    await renderRoute("/v/sample");
    expect(await screen.findByRole("tab", { name: "Welcome" })).toBeInTheDocument();
  });
});

describe("file operations", () => {
  it("creates a note and opens it", async () => {
    const api = server();
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "New note" }));
    const dialog = await screen.findByRole("dialog", { name: "New note" });
    const input = within(dialog).getByRole("textbox", { name: "Name" });
    expect(input).toHaveValue("Untitled");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/v/sample/Untitled.md"));
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/vaults/sample/files/Untitled.md");
    expect(put?.body).toEqual({ content: "", baseVersion: null });
  });

  it("refuses a name that is taken or not allowed without calling the server", async () => {
    const api = server();
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "New note" }));
    const dialog = await screen.findByRole("dialog", { name: "New note" });
    const input = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "a/b");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("That name cannot be used");
    await user.clear(input);
    await user.type(input, "welcome");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists");
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("creates a folder inside the folder picked in the context menu", async () => {
    const api = server({
      "POST /api/vaults/sample/folders": () =>
        Response.json({ path: "Projects/Ideas" }, { status: 201 }),
    });
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    fireEvent.contextMenu(await treeitem("Projects"));
    await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    expect(dialog).toHaveTextContent("Location: /Projects");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Ideas");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.url.endsWith("/folders"))?.body).toEqual({
        path: "Projects/Ideas",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the context menu with Escape and offers ZIP download only where it applies", async () => {
    server();
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    fireEvent.contextMenu(await treeitem("Welcome.md"));
    expect(await screen.findByRole("menu", { name: "Welcome.md" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Download as ZIP" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(await treeitem("Projects"));
    expect(await screen.findByRole("menuitem", { name: "Download as ZIP" })).toBeInTheDocument();
  });

  it("renames with F2 and follows the open file", async () => {
    const api = server();
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample/Welcome.md");
    await screen.findByRole("article", { name: "Welcome.md" });
    await user.click(await treeitem("Welcome.md"));
    await user.keyboard("{F2}");
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    const input = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "Start.md");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.url.endsWith("/move"))?.body).toEqual({
        from: "Welcome.md",
        to: "Start.md",
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/v/sample/Start.md"));
    expect(screen.queryByRole("tab", { name: "Welcome" })).toBeNull();
  });

  it("deletes after confirmation, closes its tab and leaves the file", async () => {
    const api = server();
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample/Welcome.md");
    await screen.findByRole("article", { name: "Welcome.md" });
    await user.click(await treeitem("Welcome.md"));
    await user.keyboard("{Delete}");
    const dialog = await screen.findByRole("dialog", { name: "Delete Welcome.md?" });
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toBe("/v/sample"));
    expect(screen.queryByRole("tab", { name: "Welcome" })).toBeNull();
  });

  it("moves a row by dropping it on a folder, and refuses a drop into itself", async () => {
    const api = server();
    await renderRoute("/v/sample");
    const dataTransfer = {
      types: [] as string[],
      setData(type: string) {
        this.types.push(type);
      },
      effectAllowed: "",
      dropEffect: "",
    };
    const note = await treeitem("Welcome.md");
    const folder = await treeitem("Projects");
    fireEvent.dragStart(note, { dataTransfer });
    fireEvent.dragOver(folder, { dataTransfer });
    expect(folder).toHaveAttribute("data-drop");
    fireEvent.drop(folder, { dataTransfer });
    await waitFor(() =>
      expect(api.calls.find((c) => c.url.endsWith("/move"))?.body).toEqual({
        from: "Welcome.md",
        to: "Projects/Welcome.md",
      }),
    );

    api.calls.length = 0;
    fireEvent.dragStart(folder, { dataTransfer });
    fireEvent.dragOver(folder, { dataTransfer });
    expect(folder).not.toHaveAttribute("data-drop");
    fireEvent.drop(folder, { dataTransfer });
    expect(api.calls.some((c) => c.url.endsWith("/move"))).toBe(false);
  });

  it("imports dropped text files, numbers a taken name and skips binary files", async () => {
    const api = server({
      "PUT /api/vaults/sample/files/Welcome 2.md": () =>
        Response.json({ path: "Welcome 2.md", version: "v", mtime: 1 }),
      "PUT /api/vaults/sample/files/Projects/notes.txt": () =>
        Response.json({ path: "Projects/notes.txt", version: "v", mtime: 1 }),
    });
    await renderRoute("/v/sample");
    const folder = await treeitem("Projects");
    const text = new File(["hello"], "notes.txt", { type: "text/plain" });
    const binary = new File([new Uint8Array([0, 1, 2])], "pic.png", { type: "image/png" });
    fireEvent.drop(folder, {
      dataTransfer: { types: ["Files"], items: [], files: [text, binary] },
    });
    expect(await screen.findByText("Imported 1 file")).toBeInTheDocument();
    expect(screen.getByText(/1 file was skipped/)).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "PUT")?.url).toBe(
      "/api/vaults/sample/files/Projects/notes.txt",
    );

    const clash = new File(["x"], "Welcome.md");
    fireEvent.drop(screen.getByRole("tree").parentElement as HTMLElement, {
      dataTransfer: { types: ["Files"], items: [], files: [clash] },
    });
    await waitFor(() =>
      expect(api.calls.some((c) => c.url === "/api/vaults/sample/files/Welcome%202.md")).toBe(true),
    );
  });

  it("shows a translated error when the server refuses", async () => {
    server({
      "POST /api/vaults/sample/move": () =>
        Response.json({ code: "forbidden", message: "x" }, { status: 403 }),
    });
    const user = userEvent.setup();
    await renderRoute("/v/sample", "zh-TW");
    const dialogTitle = "重新命名";
    await user.click(await treeitem("Welcome.md"));
    await user.keyboard("{F2}");
    const dialog = await screen.findByRole("dialog", { name: dialogTitle });
    const input = within(dialog).getByRole("textbox");
    await user.clear(input);
    await user.type(input, "B.md");
    await user.click(within(dialog).getByRole("button", { name: dialogTitle }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("你沒有執行此操作的權限。");
  });
});

describe("vault switcher, quick open and commands", () => {
  it("lists the vaults and switches to another", async () => {
    server({ "GET /api/vaults/other/files": () => Response.json({ tree: [] }) });
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Switch vault" }));
    expect(screen.getByRole("menuitemradio", { name: "sample" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("menuitemradio", { name: "other" }));
    expect(router.state.location.pathname).toBe("/v/other");
  });

  it("opens a file from Ctrl+P by a few letters of its path", async () => {
    server();
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample");
    await treeitem("Welcome.md");
    await user.keyboard("{Control>}p{/Control}");
    const box = await screen.findByRole("combobox", { name: "Quick open" });
    expect(box).toHaveFocus();
    await user.type(box, "pjplan");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Plan");
    expect(options[0]).toHaveTextContent("Projects");
    await user.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe("/v/sample/Projects/Plan.md");
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("moves through results with the arrow keys, says when nothing matches, closes on Escape", async () => {
    server();
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample");
    await treeitem("Welcome.md");
    await user.keyboard("{Control>}p{/Control}");
    const box = await screen.findByRole("combobox");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    await user.type(box, "zzzz");
    expect(screen.getByText("No file matches.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(router.state.location.pathname).toBe("/v/sample");
  });

  it("runs commands from the palette", async () => {
    server();
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await treeitem("Welcome.md");
    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    const box = await screen.findByRole("combobox", { name: "Command palette" });
    await user.type(box, "new fol");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "New folder" })).toBeInTheDocument();
  });

  it("offers commands that act on the open file only when one is open", async () => {
    server();
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await treeitem("Welcome.md");
    await user.click(screen.getByRole("button", { name: "Commands" }));
    expect(screen.queryByRole("option", { name: /Rename/ })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("treeitem", { name: /^Welcome.md/ }));
    await user.click(screen.getByRole("button", { name: "Commands" }));
    expect(await screen.findByRole("option", { name: /Rename/ })).toBeInTheDocument();
  });
});
