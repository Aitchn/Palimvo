import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.ts";
import { mockMatchMedia, mockRoutes, renderRoute, renderWithProviders } from "../test/render.tsx";
import { AuthorBadge, topRole } from "./RoleBadge.tsx";

const everyone = {
  id: "e",
  name: "@everyone",
  position: 0,
  permissions: [],
  joinDeny: [],
  everyone: true,
  manageable: false,
  memberCount: 3,
};
const designer = {
  id: "r1",
  name: "Designer",
  color: "#aa3366",
  position: 20,
  permissions: ["vaults.create"],
  joinDeny: [],
  everyone: false,
  manageable: true,
  memberCount: 1,
};
const reader = {
  id: "r2",
  name: "Reader",
  position: 10,
  permissions: [],
  joinDeny: ["note.write"],
  everyone: false,
  manageable: true,
  memberCount: 0,
};

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
  localStorage.clear();
});

describe("roles page", () => {
  const server = () =>
    mockRoutes({
      "GET /api/admin/roles": () => Response.json({ roles: [everyone, reader, designer] }),
      "GET /api/admin/roles/r1/members": () =>
        Response.json({ members: [{ id: "u1", username: "dana", displayName: "Dana Lee" }] }),
      "GET /api/admin/users": () => Response.json({ users: [] }),
      "PATCH /api/admin/roles/r1": () => Response.json(designer),
      "POST /api/admin/roles": () =>
        Response.json({ ...designer, id: "r9", name: "QA" }, { status: 201 }),
    });

  it("lists roles by rank and shows the selected one's members", async () => {
    server();
    await renderRoute("/settings/roles");
    const list = await screen.findByRole("list", { name: "Roles, highest rank first" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(names[0]).toContain("Designer");
    expect(names[1]).toContain("Reader");
    expect(names[2]).toContain("@everyone");
    expect(await screen.findByText("Dana Lee")).toBeInTheDocument();
  });

  it("saves a new colour and a permission switch", async () => {
    const user = userEvent.setup();
    const api = server();
    await renderRoute("/settings/roles");
    const form = await screen.findByRole("form", { name: "Edit role Designer" });
    const save = within(form).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.click(within(form).getByRole("radio", { name: "#3b82f6" }));
    await user.click(within(form).getByRole("switch", { name: /Use the AI assistant/ }));
    await user.click(save);
    await waitFor(() => expect(api.calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({
      name: "Designer",
      color: "#3b82f6",
      permissions: ["vaults.create", "assistant.use"],
      joinDeny: [],
    });
  });

  it("moves a role down by renumbering the ranks", async () => {
    const user = userEvent.setup();
    const api = server();
    await renderRoute("/settings/roles");
    await user.click(await screen.findByRole("button", { name: "Move Designer down" }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    const patches = api.calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => [c.url, c.body])).toEqual([
      ["/api/admin/roles/r1", { position: 10 }],
      ["/api/admin/roles/r2", { position: 20 }],
    ]);
  });

  it("creates a role and selects it", async () => {
    const user = userEvent.setup();
    const api = server();
    await renderRoute("/settings/roles");
    await user.type(await screen.findByLabelText("New role name"), "QA");
    await user.click(screen.getByRole("button", { name: "Create role" }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({ name: "QA" }),
    );
  });

  it("only offers the roles page to people who manage roles", async () => {
    mockRoutes({
      "GET /api/me/permissions": () => Response.json({ server: ["users.manage"] }),
      "GET /api/auth/me": () =>
        Response.json({
          state: "account",
          account: {
            id: "a2",
            username: "bo",
            displayName: "Bo",
            serverAdmin: false,
            disabled: false,
            createdAt: 1,
          },
          csrfToken: "t",
        }),
      "GET /api/auth/sessions": () => Response.json({ sessions: [] }),
    });
    await renderRoute("/settings/account");
    await screen.findByRole("heading", { name: "Profile" });
    expect(screen.queryByRole("link", { name: "Roles" })).toBeNull();
    expect(screen.getByRole("link", { name: "People" })).toBeInTheDocument();
  });
});

describe("vault permissions", () => {
  const roles = [
    { id: "r1", name: "Designer", color: "#aa3366", position: 20 },
    { id: "r2", name: "Reader", position: 10 },
  ];
  const vaultPerms = {
    server: ["roles.manage"],
    vault: ["vault.view", "note.read", "permissions.manage", "members.manage"],
  };

  const server = (overrides: unknown[] = []) =>
    mockRoutes({
      "GET /api/me/permissions": () => Response.json(vaultPerms),
      "GET /api/vaults/notes/members": () => Response.json({ members: [] }),
      "GET /api/vaults/notes/permissions": () => Response.json({ roles, people: [], overrides }),
      "PUT /api/vaults/notes/permissions": (call) =>
        Response.json({
          roles,
          people: [],
          overrides: [{ ...(call.body as object), subjectType: "role", subjectId: "r1" } as never],
        }),
      "GET /api/vaults/notes/permissions/preview": () =>
        Response.json({ permissions: ["vault.view", "note.read"] }),
      "GET /api/vaults/notes/people": () =>
        Response.json({
          people: [{ id: "u1", username: "dana", displayName: "Dana Lee", member: true }],
        }),
    });

  it("denies a permission for a role with the three-state control", async () => {
    const user = userEvent.setup();
    const api = server([{ subjectType: "role", subjectId: "r1", allow: [], deny: [] }]);
    await renderRoute("/settings/vaults/notes");
    const write = await screen.findByRole("radiogroup", { name: "Write notes" });
    expect(within(write).getByRole("radio", { name: "Inherit" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(within(write).getByRole("radio", { name: "Deny" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "PUT")).toBe(true));
    expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
      subjectType: "role",
      subjectId: "r1",
      allow: [],
      deny: ["note.write"],
    });
  });

  it("adds a role and previews what it can do", async () => {
    const user = userEvent.setup();
    const api = server();
    await renderRoute("/settings/vaults/notes");
    await user.selectOptions(await screen.findByLabelText("Add a rule for a role"), "r2");
    expect(await screen.findByRole("radiogroup", { name: "Write notes" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("A role"), "r1");
    const effective = await screen.findByRole("list", { name: "What they can do" });
    expect(within(effective).getByText("See the vault").closest("li")).toHaveAttribute(
      "data-allowed",
    );
    expect(within(effective).getByText("Write notes").closest("li")).not.toHaveAttribute(
      "data-allowed",
    );
    expect(api.calls.some((c) => c.url === "/api/vaults/notes/permissions/preview?roleId=r1")).toBe(
      true,
    );
  });

  it("finds a person by name for a personal rule", async () => {
    const user = userEvent.setup();
    server();
    await renderRoute("/settings/vaults/notes");
    await user.type(await screen.findByLabelText("Add a rule for a person"), "dan");
    await user.click(await screen.findByRole("button", { name: /Dana Lee/ }));
    const row = (await screen.findByText("person")).closest("li")!;
    expect(within(row).getByText("Dana Lee")).toBeInTheDocument();
  });

  it("lists folders with their own rules", async () => {
    server([
      { folder: "design", subjectType: "role", subjectId: "r1", allow: ["note.write"], deny: [] },
    ]);
    await renderRoute("/settings/vaults/notes");
    expect(await screen.findByRole("button", { name: "Edit design" })).toBeInTheDocument();
  });
});

describe("folder menu", () => {
  const files = {
    tree: [
      {
        name: "design",
        path: "design",
        type: "folder",
        children: [{ name: "a.md", path: "design/a.md", type: "file", kind: "markdown" }],
      },
    ],
  };
  const server = (vault: string[]) =>
    mockRoutes({
      "GET /api/vaults": () => Response.json({ vaults: [{ id: "notes", name: "notes" }] }),
      "GET /api/vaults/notes/files": () => Response.json(files),
      "GET /api/me/permissions": () => Response.json({ server: [], vault }),
      "GET /api/vaults/notes/permissions": () =>
        Response.json({
          roles: [{ id: "r1", name: "Designer", position: 20 }],
          people: [],
          overrides: [
            {
              folder: "design",
              subjectType: "role",
              subjectId: "r1",
              allow: ["note.write"],
              deny: [],
            },
          ],
        }),
    });

  it("opens the folder's permissions from the right-click menu", async () => {
    server(["vault.view", "note.read", "note.write", "permissions.manage"]);
    await renderRoute("/v/notes");
    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /^design/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Permissions…" }));
    const dialog = await screen.findByRole("dialog", { name: "Permissions for design" });
    const write = await within(dialog).findByRole("radiogroup", { name: "Write notes" });
    expect(within(write).getByRole("radio", { name: "Allow" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Only write-type permissions can be set per folder.
    expect(within(dialog).queryByRole("radiogroup", { name: "Read notes" })).toBeNull();
  });

  it("does not offer it to someone who cannot manage permissions", async () => {
    server(["vault.view", "note.read", "note.write"]);
    await renderRoute("/v/notes");
    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /^design/ }));
    await screen.findByRole("menuitem", { name: "New note" });
    expect(screen.queryByRole("menuitem", { name: "Permissions…" })).toBeNull();
  });
});

describe("role labels", () => {
  it("picks the highest role that has a colour", () => {
    expect(
      topRole([
        { id: "a", name: "A", position: 30 },
        { id: "b", name: "B", color: "#111111", position: 20 },
        { id: "c", name: "C", color: "#222222", position: 10 },
      ])?.name,
    ).toBe("B");
    expect(topRole([])).toBeUndefined();
  });

  it("shows the role next to a person's name but not next to an AI", async () => {
    const roster = new Map([
      [
        "dana",
        {
          authorId: "dana",
          name: "Dana",
          position: "member" as const,
          roles: [{ id: "r1", name: "Designer", color: "#aa3366", position: 20 }],
        },
      ],
    ]);
    await renderWithProviders(
      <>
        <AuthorBadge name="Dana" authorId="dana" roster={roster} />
        <AuthorBadge name="Claude Code" roster={roster} />
      </>,
    );
    expect(screen.getByText("Designer")).toBeInTheDocument();
    expect(screen.getAllByText(/Dana|Claude Code/)).toHaveLength(2);
    expect(screen.getAllByText("Designer")).toHaveLength(1);
  });
});
