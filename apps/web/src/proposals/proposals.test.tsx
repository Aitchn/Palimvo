import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Proposal, ProposalSummary } from "../api/proposals.ts";
import { useAsync } from "../app/useAsync.ts";
import { listProposals } from "../api/proposals.ts";
import { mockMatchMedia, mockRoutes, renderWithProviders } from "../test/render.tsx";
import { initTheme } from "../theme/theme.ts";
import { ProposalsPanel } from "./ProposalsPanel.tsx";

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
});

const claude = { kind: "ai" as const, id: "claude", name: "Claude Code" };

const hunk = (id: string, before: string, after: string, over = {}) => ({
  id,
  before,
  after,
  rationale: `Change ${id}`,
  contextBefore: "We ship in ",
  contextAfter: ".\n",
  state: "pending" as const,
  ...over,
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: "p1",
  version: 1,
  title: "Tidy the plan",
  rationale: "The dates slipped",
  sources: [],
  proposedBy: claude,
  createdAt: "2026-10-22T09:00:00Z",
  updatedAt: "2026-10-22T09:00:00Z",
  state: "pending",
  stale: false,
  files: [
    {
      path: "Plan.md",
      status: "current",
      hunks: [hunk("h1", "March", "April"), hunk("h2", "May", "June")],
    },
    { path: "Notes.md", status: "current", hunks: [hunk("h3", "a", "b")] },
  ],
  ...over,
});

const summary = (p: Proposal): ProposalSummary => ({
  id: p.id,
  version: p.version,
  title: p.title,
  rationale: p.rationale,
  state: p.state,
  stale: p.stale,
  proposedBy: p.proposedBy,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  files: p.files.map((f) => ({
    path: f.path,
    status: f.status,
    pending: f.hunks.filter((h) => h.state === "pending").length,
    accepted: 0,
    rejected: 0,
  })),
});

function Harness({ canReview, onChanged }: { canReview: boolean; onChanged?: () => void }) {
  const [all, setAll] = useState(false);
  const proposals = useAsync((signal) => listProposals("v", { all, signal }), `p:${all}`);
  return (
    <ProposalsPanel
      vault="v"
      proposals={proposals}
      showAll={all}
      onShowAll={setAll}
      canReview={canReview}
      onChanged={onChanged ?? (() => {})}
      onOpenFile={() => {}}
    />
  );
}

const routes = (p: Proposal) => ({
  "GET /api/vaults/v/proposals": () => Response.json({ proposals: [summary(p)] }),
  "GET /api/vaults/v/proposals?state=all": () => Response.json({ proposals: [summary(p)] }),
  "GET /api/vaults/v/roster": () => Response.json({ people: [] }),
  "GET /api/vaults/v/proposals/p1": () => Response.json(p),
});

describe("proposals panel", () => {
  it("lists what is waiting with who proposed it", async () => {
    mockRoutes(routes(proposal()));
    await renderWithProviders(<Harness canReview />);
    const list = await screen.findByRole("list", { name: "Proposed changes" });
    const card = within(list).getByRole("listitem");
    expect(within(card).getByText("Tidy the plan")).toBeInTheDocument();
    expect(within(card).getByText("Claude Code")).toBeInTheDocument();
    expect(within(card).getByText("AI")).toBeInTheDocument();
    expect(within(card).getByText("Changes waiting: 3")).toBeInTheDocument();
    expect(within(card).getByText("Plan.md, Notes.md")).toBeInTheDocument();
  });

  it("accepts only the changes that were picked, across files", async () => {
    const decided = proposal({
      version: 2,
      state: "partial",
      files: [
        {
          path: "Plan.md",
          status: "current",
          hunks: [hunk("h1", "March", "April", { state: "accepted" }), hunk("h2", "May", "June")],
        },
        {
          path: "Notes.md",
          status: "current",
          hunks: [hunk("h3", "a", "b", { state: "accepted" })],
        },
      ],
    });
    const { calls } = mockRoutes({
      ...routes(proposal()),
      "POST /api/vaults/v/proposals/p1/accept": () => Response.json(decided),
    });
    const user = userEvent.setup();
    let changed = 0;
    await renderWithProviders(<Harness canReview onChanged={() => changed++} />);
    await user.click(await screen.findByRole("button", { name: "Review Tidy the plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Tidy the plan" });
    expect(within(dialog).getByText("The dates slipped")).toBeInTheDocument();
    // The whole line is shown, with the old and new text.
    expect(within(dialog).getAllByText(/We ship in March\./).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/We ship in April\./).length).toBeGreaterThan(0);

    const accept = within(dialog).getByRole("button", { name: /Accept selected/ });
    expect(accept).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: "Change 1 in Plan.md" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Change 1 in Notes.md" }));
    expect(accept).toHaveTextContent("Accept selected (2)");
    await user.click(accept);

    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        version: 1,
        hunkIds: ["h1", "h3"],
      }),
    );
    // The dialog now shows the decisions, and the rest stays open for another round.
    expect(await within(dialog).findAllByText("Accepted")).toHaveLength(2);
    expect(within(dialog).getByRole("checkbox", { name: "Change 2 in Plan.md" })).not.toBeChecked();
    await waitFor(() => expect(changed).toBe(1));
  });

  it("rejects chosen changes", async () => {
    const { calls } = mockRoutes({
      ...routes(proposal()),
      "POST /api/vaults/v/proposals/p1/reject": () =>
        Response.json(proposal({ version: 2, state: "partial" })),
    });
    const user = userEvent.setup();
    await renderWithProviders(<Harness canReview />);
    await user.click(await screen.findByRole("button", { name: "Review Tidy the plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Tidy the plan" });
    await user.click(
      within(dialog).getByRole("button", { name: "Select all that can be accepted" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Reject selected (3)" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        version: 1,
        hunkIds: ["h1", "h2", "h3"],
      }),
    );
  });

  it("will not accept changes in a note that changed since, but still allows rejecting them", async () => {
    const stale = proposal({
      stale: true,
      files: [
        { path: "Plan.md", status: "stale", hunks: [hunk("h1", "March", "April")] },
        { path: "Notes.md", status: "current", hunks: [hunk("h3", "a", "b")] },
      ],
    });
    mockRoutes(routes(stale));
    const user = userEvent.setup();
    await renderWithProviders(<Harness canReview />);
    await user.click(await screen.findByRole("button", { name: "Review Tidy the plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Tidy the plan" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("cannot be accepted any more");
    expect(within(dialog).getByText("Changed since")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("checkbox", { name: "Change 1 in Plan.md" }));
    expect(within(dialog).getByRole("button", { name: "Accept selected (1)" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Reject selected (1)" })).toBeEnabled();
    // "Select all" skips what can no longer be accepted.
    await user.click(within(dialog).getByRole("button", { name: "Select none" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Select all that can be accepted" }),
    );
    expect(within(dialog).getByRole("button", { name: "Accept selected (1)" })).toBeEnabled();
  });

  it("shows a proposal read-only to someone who may not decide", async () => {
    mockRoutes(routes(proposal()));
    const user = userEvent.setup();
    await renderWithProviders(<Harness canReview={false} />);
    await user.click(await screen.findByRole("button", { name: "Review Tidy the plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Tidy the plan" });
    expect(within(dialog).getByText(/needs the review permission/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: /Accept selected/ }),
    ).not.toBeInTheDocument();
  });

  it("explains a refused decision", async () => {
    mockRoutes({
      ...routes(proposal()),
      "POST /api/vaults/v/proposals/p1/accept": () =>
        Response.json({ code: "proposal_changed", message: "x" }, { status: 409 }),
    });
    const user = userEvent.setup();
    await renderWithProviders(<Harness canReview />);
    await user.click(await screen.findByRole("button", { name: "Review Tidy the plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Tidy the plan" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Change 1 in Plan.md" }));
    await user.click(within(dialog).getByRole("button", { name: "Accept selected (1)" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already decided");
  });
});
