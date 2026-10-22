import { baseFile, parseBase, queryBase, setNoteProperty } from "@palimvo/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRoutes, renderWithProviders, type RecordedCall } from "../test/render.tsx";
import { BaseView, type BaseTarget } from "./BaseView.tsx";

const BASE = `filters:
  and:
    - file.inFolder("Tasks")
views:
  - type: table
    name: All
    order:
      - file.name
      - status
      - tags
  - type: cards
    name: Board
    order:
      - file.name
      - status
`;

/** A small fake vault: the notes, a .base file, and the routes a database talks to. */
function vault(options: { base?: string } = {}) {
  const notes: Record<string, string> = {
    "Tasks/Alpha.md": "---\nstatus: open\ntags: [task, urgent]\n---\n# Alpha\n",
    "Tasks/Beta.md": "---\nstatus: done\ntags: [task]\n---\n# Beta\n",
    "Other/Gamma.md": "---\nstatus: open\n---\n# Gamma\n",
  };
  let base = options.base ?? BASE;
  let baseVersion = "b1";
  const run = (q: { path?: string; source?: string; view?: string | number }) => {
    const files = Object.entries(notes).map(([path, content]) =>
      baseFile({ path, content, mtime: 1 }, Object.keys(notes)),
    );
    const source = q.path ? base : q.source!;
    const result = queryBase(
      parseBase(source),
      files,
      q.view === undefined ? {} : { view: q.view },
    );
    return q.path ? { ...result, version: baseVersion } : result;
  };
  const server = mockRoutes({
    "POST /api/vaults/v/bases/query": (call) => {
      try {
        return Response.json(run(call.body as never));
      } catch (error) {
        return Response.json(
          { code: "invalid_request", message: (error as Error).message },
          { status: 400 },
        );
      }
    },
    "GET /api/vaults/v/files/Tasks.base": () =>
      Response.json({ path: "Tasks.base", content: base, mtime: 1, version: baseVersion }),
    "PUT /api/vaults/v/files/Tasks.base": (call) => {
      base = (call.body as { content: string }).content;
      baseVersion = `b${Number(baseVersion.slice(1)) + 1}`;
      return Response.json({ path: "Tasks.base", version: baseVersion, mtime: 2 });
    },
    "POST /api/vaults/v/bases/property": (call) => {
      const { path, key, value } = call.body as { path: string; key: string; value: never };
      notes[path] = setNoteProperty(notes[path]!, key, value);
      return Response.json({ path, version: "n2", mtime: 2 });
    },
    "PUT /api/vaults/v/files/Tasks/New.md": () =>
      Response.json({ path: "Tasks/New.md", version: "n1", mtime: 2 }),
  });
  return { ...server, notes, base: () => base };
}

const FILE: BaseTarget = { kind: "file", path: "Tasks.base" };
const calls = (all: RecordedCall[], method: string, url: string) =>
  all.filter((c) => c.method === method && c.url === url);

async function show(
  target: BaseTarget = FILE,
  canEdit = true,
  extra: Partial<Parameters<typeof BaseView>[0]> = {},
) {
  const server = vault();
  const onOpen = vi.fn();
  await renderWithProviders(
    <BaseView vault="v" target={target} canEdit={canEdit} onOpen={onOpen} {...extra} />,
  );
  return { ...server, onOpen };
}

beforeEach(() => {
  localStorage.clear();
});

describe("BaseView table", () => {
  it("lists the notes the filters match, with their properties", async () => {
    await show();
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    // header + Alpha + Beta; Other/Gamma is outside the folder
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("Alpha")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("#urgent")).toBeInTheDocument();
    expect(screen.queryByText("Gamma")).toBeNull();
    expect(screen.getByText("2 notes")).toBeInTheDocument();
    // File fields are translated, properties keep their names.
    expect(within(table).getByRole("button", { name: "Name" })).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "status" })).toBeInTheDocument();
  });

  it("opens a note from its name", async () => {
    const { onOpen } = await show();
    await userEvent.click(await screen.findByRole("button", { name: "Alpha" }));
    expect(onOpen).toHaveBeenCalledWith("Tasks/Alpha.md");
  });

  it("edits a cell: sends the property and shows the new value", async () => {
    const user = userEvent.setup();
    const { calls: all, notes } = await show();
    await user.click((await screen.findAllByTitle("Click to edit"))[0]!);
    const input = screen.getByRole("textbox", { name: "status" });
    await user.clear(input);
    await user.type(input, "doing{Enter}");
    await waitFor(() => expect(calls(all, "POST", "/api/vaults/v/bases/property")).toHaveLength(1));
    expect(calls(all, "POST", "/api/vaults/v/bases/property")[0]!.body).toEqual({
      path: "Tasks/Alpha.md",
      key: "status",
      value: "doing",
    });
    expect(notes["Tasks/Alpha.md"]).toContain("status: doing");
    expect(await screen.findByText("doing")).toBeInTheDocument();
  });

  it("cancels a cell edit with Escape", async () => {
    const user = userEvent.setup();
    const { calls: all } = await show();
    await user.click((await screen.findAllByTitle("Click to edit"))[0]!);
    await user.type(screen.getByRole("textbox", { name: "status" }), "zzz{Escape}");
    expect(calls(all, "POST", "/api/vaults/v/bases/property")).toHaveLength(0);
  });

  it("sorts by a column and saves the choice in the file", async () => {
    const user = userEvent.setup();
    const { calls: all, base } = await show();
    await user.click(await screen.findByRole("button", { name: "status" }));
    await waitFor(() =>
      expect(calls(all, "PUT", "/api/vaults/v/files/Tasks.base")).toHaveLength(1),
    );
    const put = calls(all, "PUT", "/api/vaults/v/files/Tasks.base")[0]!;
    expect(put.body).toMatchObject({ baseVersion: "b1" });
    expect(parseBase(base()).views[0]!.sort).toEqual([{ property: "status", direction: "ASC" }]);
    const rows = await screen.findAllByRole("row");
    // done < open
    await waitFor(() =>
      expect(within(screen.getAllByRole("row")[1]!).getByText("Beta")).toBeInTheDocument(),
    );
    expect(rows.length).toBe(3);
  });

  it("groups the rows by a property", async () => {
    const user = userEvent.setup();
    const { base } = await show();
    await screen.findByRole("table");
    await user.selectOptions(screen.getByRole("combobox", { name: "Group by" }), "status");
    await waitFor(() => expect(parseBase(base()).views[0]!.groupBy?.property).toBe("status"));
    await waitFor(() => expect(document.querySelectorAll(".base-group-row")).toHaveLength(2));
    const headings = [...document.querySelectorAll(".base-group-row")].map((r) => r.textContent);
    expect(headings).toEqual(["done 1", "open 1"]);
  });

  it("shows cards in another view", async () => {
    const user = userEvent.setup();
    await show();
    await screen.findByRole("table");
    await user.click(screen.getByRole("tab", { name: /Board/ }));
    expect(await screen.findByText("Beta", { selector: ".base-card-title" })).toBeInTheDocument();
    expect(document.querySelectorAll(".base-card")).toHaveLength(2);
  });
});

describe("BaseView settings", () => {
  it("adds a filter condition for every view and re-runs the query", async () => {
    const user = userEvent.setup();
    const { base } = await show();
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    const panel = document.querySelector(".base-filters") as HTMLElement;
    const shared = within(panel).getAllByRole("combobox", { name: "Condition type" })[0]!;
    await user.selectOptions(shared, "property");
    const form = shared.closest("form")!;
    await user.type(within(form).getByRole("combobox", { name: "Property" }), "status");
    await user.type(within(form).getByRole("textbox", { name: "Value" }), "open");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(parseBase(base()).filters).toEqual({
        and: ['file.inFolder("Tasks")', 'status == "open"'],
      }),
    );
    await waitFor(() => expect(screen.queryByText("Beta")).toBeNull());
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("creates a note that already matches the filters", async () => {
    const user = userEvent.setup();
    const { calls: all } = await show();
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "New note" }));
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByRole("textbox");
    await user.clear(name);
    await user.type(name, "New");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(calls(all, "PUT", "/api/vaults/v/files/Tasks/New.md")).toHaveLength(1),
    );
    expect(calls(all, "PUT", "/api/vaults/v/files/Tasks/New.md")[0]!.body).toMatchObject({
      content: "# New\n",
      baseVersion: null,
    });
  });

  it("adds, renames and deletes a view", async () => {
    const user = userEvent.setup();
    const { base } = await show();
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Add view" }));
    let dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByRole("textbox"));
    await user.type(within(dialog).getByRole("textbox"), "Third");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(parseBase(base()).views.map((v) => v.name)).toEqual(["All", "Board", "Third"]),
    );

    await user.click(await screen.findByRole("button", { name: "Rename view" }));
    dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByRole("textbox"));
    await user.type(within(dialog).getByRole("textbox"), "Renamed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(parseBase(base()).views.at(-1)!.name).toBe("Renamed"));

    await user.click(await screen.findByRole("button", { name: "Delete view" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(parseBase(base()).views.map((v) => v.name)).toEqual(["All", "Board"]),
    );
  });

  it("applies YAML edits and refuses YAML that does not parse", async () => {
    const user = userEvent.setup();
    const { base } = await show();
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "YAML" }));
    const area = screen.getByRole("textbox", { name: "Database settings (YAML)" });
    await user.clear(area);
    await user.click(area);
    await user.paste("views: [");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(base()).toBe(BASE);
    await user.clear(area);
    await user.click(area);
    await user.paste("views:\n  - type: table\n    name: Everything\n");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(parseBase(base()).views[0]!.name).toBe("Everything"));
    expect(await screen.findByText("3 notes")).toBeInTheDocument();
  });

  it("reports a version conflict and loads the latest settings", async () => {
    const user = userEvent.setup();
    const { handlers } = await show();
    await screen.findByRole("table");
    handlers["PUT /api/vaults/v/files/Tasks.base"] = () =>
      Response.json({ code: "version_conflict", message: "changed" }, { status: 409 });
    await user.click(screen.getByRole("button", { name: "status" }));
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument();
  });
});

describe("BaseView without edit rights", () => {
  it("shows the rows but no controls to change anything", async () => {
    await show(FILE, false);
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(screen.queryByRole("button", { name: "YAML" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Filters/ })).toBeNull();
    expect(screen.queryByTitle("Click to edit")).toBeNull();
    // Headings are plain text, not sort buttons.
    expect(screen.queryByRole("button", { name: "status" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "status" })).toBeInTheDocument();
  });
});

describe("BaseView inline", () => {
  const source = "views:\n  - type: table\n    name: Here\n    order:\n      - file.name\n";

  it("runs the YAML of a block and hands changed settings back to the note", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { calls: all } = await show(
      { kind: "inline", source, thisPath: "Plan.md", onChange },
      true,
      { embedded: true },
    );
    await screen.findByRole("table");
    const query = calls(all, "POST", "/api/vaults/v/bases/query")[0]!;
    expect(query.body).toMatchObject({ source, thisPath: "Plan.md" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Display as" }), "cards");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(parseBase(onChange.mock.calls[0]![0] as string).views[0]!.type).toBe("cards");
    // Nothing is written to a file: the note owns the block.
    expect(calls(all, "PUT", "/api/vaults/v/files/Tasks.base")).toHaveLength(0);
  });

  it("cannot be configured when the note is not editable", async () => {
    await show({ kind: "inline", source, thisPath: "Plan.md" }, true, { embedded: true });
    await screen.findByRole("table");
    expect(screen.queryByRole("combobox", { name: "Display as" })).toBeNull();
    expect(screen.queryByRole("button", { name: "YAML" })).toBeNull();
  });

  it("offers a way to open the database a note embeds", async () => {
    const { onOpen } = await show(FILE, true, { embedded: true });
    await screen.findByRole("table");
    await userEvent.click(screen.getByTitle("Open database"));
    expect(onOpen).toHaveBeenCalledWith("Tasks.base");
  });
});

describe("BaseView errors", () => {
  it("says why a database cannot be shown and lets editors fix its YAML", async () => {
    const server = vault({ base: "views: [" });
    const user = userEvent.setup();
    server.handlers["POST /api/vaults/v/bases/query"] = () =>
      Response.json(
        { code: "invalid_request", message: "Unclosed flow sequence" },
        { status: 400 },
      );
    await renderWithProviders(<BaseView vault="v" target={FILE} canEdit onOpen={vi.fn()} />);
    expect(await screen.findByText("Unclosed flow sequence")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "YAML" }));
    expect(screen.getByRole("textbox", { name: "Database settings (YAML)" })).toHaveValue(
      "views: [",
    );
  });
});
