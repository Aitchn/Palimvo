import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Activity } from "../api/home.ts";
import {
  SAMPLE_HOME,
  mockMatchMedia,
  mockRoutes,
  renderRoute,
  type RecordedCall,
} from "../test/render.tsx";
import { initTheme } from "../theme/theme.ts";

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
  localStorage.clear();
});

const FILES = {
  tree: [
    { name: "Plan.md", path: "Plan.md", type: "file", kind: "markdown" },
    { name: "Notes.md", path: "Notes.md", type: "file", kind: "markdown" },
    { name: "Tasks.base", path: "Tasks.base", type: "file", kind: "base" },
  ],
};

const ada = { kind: "human", id: "ada", name: "Ada" } as const;
const claude = { kind: "ai", id: "claude-code", name: "Claude Code" } as const;

const commit = (
  id: string,
  author: typeof ada | typeof claude,
  reason: string,
  files: string[],
) => ({
  id,
  date: "2026-10-22T09:00:00Z",
  author,
  coAuthors: [],
  approvedBy: [],
  subject: reason,
  body: "",
  reasons: [reason],
  checkpoint: false,
  tags: [],
  files,
});

const ENTRIES = [
  commit("c3", claude, "Summarize the week", ["Plan.md"]),
  commit("c2", ada, "Fix the date", ["Notes.md"]),
  commit("c1", claude, "Create the plan", ["Plan.md"]),
];
const AUTHORS = [
  { author: claude, count: 2, lastAt: "2026-10-22T09:00:00Z" },
  { author: ada, count: 1, lastAt: "2026-10-22T08:00:00Z" },
];

const ALL_PERMISSIONS = [
  "vault.view",
  "note.read",
  "note.write",
  "history.view",
  "proposal.create",
  "proposal.review",
  "vault.settings",
];

function server(
  permissions: string[] = ALL_PERMISSIONS,
  extra: Record<string, (call: RecordedCall) => Response | Promise<Response>> = {},
) {
  return mockRoutes({
    "GET /api/vaults": () => Response.json({ vaults: [{ id: "sample", name: "sample" }] }),
    "GET /api/vaults/sample/files": () => Response.json(FILES, { headers: { ETag: '"t1"' } }),
    "GET /api/vaults/sample/home": () => Response.json(SAMPLE_HOME),
    "GET /api/vaults/sample/home/activity": (call) => {
      const filter = new URL(call.url, "http://x").searchParams.get("filter") ?? "all";
      const kinds = filter === "all" ? ["human", "ai"] : [filter];
      const body: Activity = {
        filter: filter as Activity["filter"],
        entries: ENTRIES.filter((e) => kinds.includes(e.author.kind)),
        authors: AUTHORS,
      };
      return Response.json(body);
    },
    "GET /api/vaults/sample/proposals": () =>
      Response.json({
        proposals: [
          {
            id: "p1",
            version: 1,
            title: "Tidy the plan",
            rationale: "",
            state: "pending",
            stale: false,
            proposedBy: claude,
            createdAt: "2026-10-22T09:00:00Z",
            updatedAt: "2026-10-22T09:00:00Z",
            files: [{ path: "Plan.md", status: "current", pending: 2, accepted: 0, rejected: 0 }],
          },
          {
            id: "p0",
            version: 3,
            title: "Old cleanup",
            rationale: "",
            state: "accepted",
            stale: false,
            proposedBy: claude,
            createdAt: "2026-10-20T09:00:00Z",
            updatedAt: "2026-10-20T09:00:00Z",
            files: [],
          },
        ],
      }),
    "GET /api/me/permissions": () => Response.json({ server: [], vault: permissions }),
    ...extra,
  });
}

describe("vault home", () => {
  it("is what a vault shows when no file is open, with the default blocks", async () => {
    server();
    await renderRoute("/v/sample");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    const blocks = await screen.findAllByRole("heading", { level: 2 });
    expect(blocks.map((b) => b.textContent)).toEqual([
      "Waiting for review",
      "Recent activity",
      "Pinned notes",
    ]);
  });

  it("groups the activity wall by author and filters people and AIs", async () => {
    const user = userEvent.setup();
    const { calls } = server();
    await renderRoute("/v/sample");
    const wall = await screen.findByRole("region", { name: "Recent activity" });
    const claudeEntries = await within(wall).findByRole("list", { name: "Changes by Claude Code" });
    expect(within(claudeEntries).getByText("Summarize the week")).toBeInTheDocument();
    expect(within(claudeEntries).getByText("Create the plan")).toBeInTheDocument();
    expect(within(wall).getByRole("list", { name: "Changes by Ada" })).toBeInTheDocument();
    // An AI's changes are marked as an AI's, not just by name.
    expect(within(wall).getAllByText("AI").length).toBeGreaterThan(0);

    await user.click(within(wall).getByRole("button", { name: /^People/ }));
    await waitFor(() =>
      expect(within(wall).queryByRole("list", { name: "Changes by Claude Code" })).toBeNull(),
    );
    expect(within(wall).getByText("Fix the date")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/home/activity?filter=human"))).toBe(true);

    await user.click(within(wall).getByRole("button", { name: /^AIs/ }));
    expect(await within(wall).findByText("Summarize the week")).toBeInTheDocument();
    expect(within(wall).queryByText("Fix the date")).toBeNull();
  });

  it("shows the proposals that still wait for a decision", async () => {
    server();
    await renderRoute("/v/sample");
    const box = await screen.findByRole("region", { name: "Waiting for review" });
    expect(await within(box).findByText("Tidy the plan")).toBeInTheDocument();
    expect(within(box).queryByText("Old cleanup")).toBeNull();
    expect(within(box).getByText("Changes waiting: 2")).toBeInTheDocument();
  });

  it("leaves out what a reader may not see", async () => {
    server(["vault.view", "note.read"]);
    await renderRoute("/v/sample");
    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(screen.queryByRole("region", { name: "Recent activity" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Waiting for review" })).toBeNull();
    // An empty pinned block is not worth showing to someone who cannot fill it.
    expect(screen.queryByRole("region", { name: "Pinned notes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Customize" })).toBeNull();
  });

  it("lists pinned notes, marks missing ones and opens them", async () => {
    const user = userEvent.setup();
    server(["vault.view", "note.read"], {
      "GET /api/vaults/sample/home": () =>
        Response.json({
          config: { ...SAMPLE_HOME.config, pinned: ["Plan.md", "Gone.md"], publicNote: "Notes.md" },
          version: "v1",
        }),
      "GET /api/vaults/sample/files/Plan.md": () =>
        Response.json({ path: "Plan.md", content: "# Plan", mtime: 1, version: "a" }),
    });
    const { router } = await renderRoute("/v/sample");
    const pinned = await screen.findByRole("region", { name: "Pinned notes" });
    expect(within(pinned).getByText("Gone.md (missing)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start here/ })).toBeInTheDocument();
    await user.click(within(pinned).getByRole("button", { name: /Plan/ }));
    expect(router.state.location.pathname).toBe("/v/sample/Plan.md");
  });

  it("customizes the page: reorders blocks, pins a note and saves with the version it started from", async () => {
    const user = userEvent.setup();
    const { calls } = server(ALL_PERMISSIONS, {
      "GET /api/vaults/sample/home": () => Response.json({ ...SAMPLE_HOME, version: "v1" }),
      "PUT /api/vaults/sample/home": (call) =>
        Response.json({ ...(call.body as object), version: "v2" }),
    });
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Customize" });
    await user.click(within(dialog).getByRole("button", { name: "Move Pinned notes up" }));
    await user.selectOptions(within(dialog).getByLabelText("Choose a note"), "Plan.md");
    await user.click(within(dialog).getByRole("button", { name: "Pin" }));
    await user.selectOptions(within(dialog).getByLabelText("Start here note"), "Notes.md");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      baseVersion: "v1",
      config: {
        schemaVersion: 1,
        widgets: [
          { id: "proposals", type: "proposals" },
          { id: "pinned", type: "pinned" },
          { id: "activity", type: "activity" },
        ],
        pinned: ["Plan.md"],
        publicNote: "Notes.md",
      },
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Customize" })).toBeNull());
  });

  it("says so when someone else saved the page first", async () => {
    const user = userEvent.setup();
    server(ALL_PERMISSIONS, {
      "PUT /api/vaults/sample/home": () =>
        Response.json({ code: "version_conflict", message: "x" }, { status: 409 }),
    });
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Customize" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Someone else changed");
  });

  it("has a way back from a file", async () => {
    const user = userEvent.setup();
    server(ALL_PERMISSIONS, {
      "GET /api/vaults/sample/files/Plan.md": () =>
        Response.json({ path: "Plan.md", content: "# Plan", mtime: 1, version: "a" }),
    });
    const { router } = await renderRoute("/v/sample/Plan.md");
    await screen.findByRole("article", { name: "Plan.md" });
    await user.click(screen.getByRole("button", { name: "Vault home" }));
    expect(router.state.location.pathname).toBe("/v/sample");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  });
});
