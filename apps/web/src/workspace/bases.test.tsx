import { baseFile, parseBase, queryBase } from "@palimvo/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.ts";
import { mockMatchMedia, mockRoutes, renderRoute, type RecordedCall } from "../test/render.tsx";

const BASE =
  'filters:\n  and:\n    - file.inFolder("Tasks")\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - status\n';
const NOTES: Record<string, string> = {
  "Tasks/Alpha.md": "---\nstatus: open\n---\n",
  "Tasks/Beta.md": "---\nstatus: done\n---\n",
};

function server(readOnly = false) {
  return mockRoutes({
    "GET /api/vaults": () => Response.json({ vaults: [{ id: "sample", name: "sample" }] }),
    "GET /api/vaults/sample/files": () =>
      Response.json({
        tree: [
          { name: "Tasks", path: "Tasks", type: "folder", children: [] },
          { name: "Tasks.base", path: "Tasks.base", type: "file", kind: "base" },
        ],
      }),
    "GET /api/vaults/sample/files/Tasks.base": () =>
      Response.json({ path: "Tasks.base", content: BASE, mtime: 1, version: "b1" }),
    "POST /api/vaults/sample/bases/query": (call: RecordedCall) => {
      const q = call.body as { path?: string; source?: string };
      const files = Object.entries(NOTES).map(([path, content]) =>
        baseFile({ path, content, mtime: 1 }, []),
      );
      return Response.json({
        ...queryBase(parseBase(q.path ? BASE : q.source!), files),
        version: "b1",
      });
    },
    "PUT /api/vaults/sample/files/Reading.base": () =>
      Response.json({ path: "Reading.base", version: "r1", mtime: 1 }),
    "GET /api/vaults/sample/files/Reading.base": () =>
      Response.json({ path: "Reading.base", content: "", mtime: 1, version: "r1" }),
    ...(readOnly
      ? {
          "GET /api/me/permissions": () =>
            Response.json({ server: [], vault: ["vault.view", "note.read"] }),
        }
      : {}),
  });
}

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
  localStorage.clear();
});

describe("databases in the workspace", () => {
  it("opens a .base file from its address and shows the rows", async () => {
    server();
    await renderRoute("/v/sample/Tasks.base");
    const article = await screen.findByRole("article", { name: "Tasks.base" });
    const table = await within(article).findByRole("table");
    expect(within(table).getByText("Alpha")).toBeInTheDocument();
    expect(within(table).getByText("done")).toBeInTheDocument();
  });

  it("is read-only for people who cannot write", async () => {
    server(true);
    await renderRoute("/v/sample/Tasks.base");
    const article = await screen.findByRole("article", { name: "Tasks.base" });
    await within(article).findByRole("table");
    expect(within(article).queryByRole("button", { name: "New note" })).toBeNull();
    expect(within(article).queryByTitle("Click to edit")).toBeNull();
  });

  it("makes a new database with the wizard and opens it", async () => {
    const api = server();
    const user = userEvent.setup();
    const { router } = await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "New database" }));
    const dialog = await screen.findByRole("dialog", { name: "New database" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("Database");
    await user.clear(name);
    await user.type(name, "Reading");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Which notes" }), "tag");
    await user.type(within(dialog).getByRole("textbox", { name: "Tag" }), "#book");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Properties to show" }),
      "author, rating",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/v/sample/Reading.base"));
    const put = api.calls.find((c) => c.method === "PUT" && c.url.endsWith("Reading.base"))!;
    expect(put.body).toMatchObject({ baseVersion: null });
    const written = parseBase((put.body as { content: string }).content);
    expect(written.filters).toEqual({ and: ['file.hasTag("book")'] });
    expect(written.views[0]!.order).toEqual(["file.name", "author", "rating"]);
  });

  it("will not overwrite a database that exists", async () => {
    const api = server();
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "New database" }));
    const dialog = await screen.findByRole("dialog", { name: "New database" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Tasks");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
