import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommitInfo } from "../api/history.ts";
import { mockMatchMedia, mockRoutes, renderWithProviders } from "../test/render.tsx";
import { initTheme } from "../theme/theme.ts";
import { ChangeLog } from "./ChangeLog.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
});

const commit = (over: Partial<CommitInfo> & Pick<CommitInfo, "id" | "author">): CommitInfo => ({
  date: "2026-10-20T09:30:00+00:00",
  coAuthors: [],
  subject: "Update",
  body: "",
  reasons: [],
  checkpoint: false,
  tags: [],
  files: ["Plan.md"],
  ...over,
});

const claude = { kind: "ai" as const, id: "claude", name: "Claude Code" };
const ada = { kind: "human" as const, id: "ada", name: "Ada" };

const commits = [
  commit({ id: "c3", author: claude, reasons: ["Added the budget table"] }),
  commit({ id: "c2", author: ada, subject: "Edit Plan.md" }),
  commit({ id: "c1", author: ada, subject: "Create Plan.md" }),
];

const roster = () =>
  Response.json({
    people: [
      {
        authorId: "ada",
        name: "Ada",
        position: "admin",
        roles: [{ id: "r1", name: "Designer", color: "#c25aa8", position: 3 }],
      },
    ],
  });

const diff = (text: string) => () => Response.json({ diff: text });

describe("file history", () => {
  it("shows who changed the file, AI clients as AI, with the reason and the person's role", async () => {
    mockRoutes({
      "GET /api/vaults/sample/history?path=Plan.md": () => Response.json({ commits }),
      "GET /api/vaults/sample/roster": roster,
    });
    await renderWithProviders(
      <HistoryPanel vault="sample" path="Plan.md" revision={0} canRestore={false} />,
    );
    const list = await screen.findByRole("list", { name: "Changes to Plan.md" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Claude Code")).toBeInTheDocument();
    expect(within(items[0]!).getByText("AI")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Added the budget table")).toBeInTheDocument();
    await waitFor(() => expect(within(items[1]!).getByText("Designer")).toBeInTheDocument());
    expect(within(items[1]!).getByText("Edit Plan.md")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });

  it("opens what a change did, and compares with another version", async () => {
    const { calls } = mockRoutes({
      "GET /api/vaults/sample/history?path=Plan.md": () => Response.json({ commits }),
      "GET /api/vaults/sample/roster": roster,
      "GET /api/vaults/sample/history/c3/diff?path=Plan.md": diff(
        "diff --git a/Plan.md b/Plan.md\n@@ -1 +1,2 @@\n kept\n+budget\n",
      ),
      "GET /api/vaults/sample/history/compare?from=c1&to=c3&path=Plan.md": diff(
        "diff --git a/Plan.md b/Plan.md\n@@ -1 +1 @@\n-old\n+new\n",
      ),
    });
    const user = userEvent.setup();
    await renderWithProviders(
      <HistoryPanel vault="sample" path="Plan.md" revision={0} canRestore={false} />,
    );
    await screen.findByRole("list", { name: "Changes to Plan.md" });
    await user.click(screen.getAllByRole("button", { name: "Changes" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Changes to Plan.md" });
    expect(await within(dialog).findByText("budget")).toBeInTheDocument();
    expect(within(dialog).getByText("Added:")).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText("Compare with"), "c1");
    expect(await within(dialog).findByText("new")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("history/compare?from=c1&to=c3"))).toBe(true);
  });

  it("puts an earlier version back after asking, but not the newest one", async () => {
    const { calls } = mockRoutes({
      "GET /api/vaults/sample/history?path=Plan.md": () => Response.json({ commits }),
      "GET /api/vaults/sample/roster": roster,
      "POST /api/vaults/sample/restore": () => Response.json({ path: "Plan.md" }),
    });
    const user = userEvent.setup();
    await renderWithProviders(
      <HistoryPanel vault="sample" path="Plan.md" revision={0} canRestore />,
    );
    await screen.findByRole("list", { name: "Changes to Plan.md" });
    // The newest entry is what the file is now; the two older ones can be restored.
    const buttons = screen.getAllByRole("button", { name: "Restore" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    const dialog = await screen.findByRole("dialog", { name: "Restore Plan.md?" });
    await user.click(within(dialog).getByRole("button", { name: "Restore this version" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        path: "Plan.md",
        commit: "c1",
      }),
    );
    expect(await screen.findByText("Version restored.")).toBeInTheDocument();
  });
});

describe("vault change log", () => {
  it("lists changes with their files and saves a checkpoint", async () => {
    let saved = false;
    const { calls } = mockRoutes({
      "GET /api/vaults/sample/history?limit=50": () => Response.json({ commits }),
      "GET /api/vaults/sample/roster": roster,
      "GET /api/vaults/sample/checkpoints": () =>
        Response.json({
          checkpoints: saved
            ? [
                {
                  name: "v1",
                  commit: "c3",
                  date: "2026-10-21T10:00:00+00:00",
                  message: "Before launch",
                },
              ]
            : [],
        }),
      "POST /api/vaults/sample/checkpoints": () => {
        saved = true;
        return Response.json(commits[0], { status: 201 });
      },
    });
    const user = userEvent.setup();
    await renderWithProviders(
      <ChangeLog vault="sample" revision={0} canCheckpoint onOpenFile={() => {}} />,
    );
    const list = await screen.findByRole("list", { name: "Changes in this vault" });
    expect(within(list).getAllByText("Plan.md")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Save a checkpoint" }));
    const dialog = await screen.findByRole("dialog", { name: "Save a checkpoint" });
    await user.type(within(dialog).getByLabelText("What is this checkpoint?"), "Before launch");
    await user.type(within(dialog).getByLabelText("Short name (optional)"), "v1");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        message: "Before launch",
        tag: "v1",
      }),
    );
    const section = await screen.findByRole("region", { name: "Checkpoints" });
    expect(within(section).getByText("v1")).toBeInTheDocument();
  });

  it("does not offer checkpoints to people who cannot write", async () => {
    mockRoutes({
      "GET /api/vaults/sample/history?limit=50": () => Response.json({ commits }),
      "GET /api/vaults/sample/roster": roster,
      "GET /api/vaults/sample/checkpoints": () => Response.json({ checkpoints: [] }),
    });
    await renderWithProviders(
      <ChangeLog vault="sample" revision={0} canCheckpoint={false} onOpenFile={() => {}} />,
    );
    await screen.findByRole("list", { name: "Changes in this vault" });
    expect(screen.queryByRole("button", { name: "Save a checkpoint" })).not.toBeInTheDocument();
  });
});
