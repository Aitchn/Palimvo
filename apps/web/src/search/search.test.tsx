import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.ts";
import { mockMatchMedia, mockRoutes, renderRoute, renderWithProviders } from "../test/render.tsx";
import { BacklinksPanel } from "./BacklinksPanel.tsx";
import { highlight } from "./highlight.tsx";

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
});

const tree = () =>
  Response.json({
    tree: [
      { name: "Plan.md", path: "Plan.md", type: "file", kind: "markdown" },
      { name: "Home.md", path: "Home.md", type: "file", kind: "markdown" },
    ],
  });

const page = (hits: unknown[], total = hits.length, offset = 0) =>
  Response.json({ query: "x", total, offset, limit: 30, hits });

describe("highlight", () => {
  it("wraps every term occurrence, ignoring case and regex characters", async () => {
    const { container } = await renderWithProviders(
      <p>{highlight("Search the (Search) panel 決策", ["search", "(", "決策"])}</p>,
    );
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual([
      "Search",
      "(",
      "Search",
      "決策",
    ]);
    expect(container.textContent).toBe("Search the (Search) panel 決策");
  });

  it("returns the text itself without terms", () => {
    expect(highlight("abc", [])).toBe("abc");
  });
});

describe("search in the sidebar", () => {
  it("searches after typing stops, highlights matches and opens a result", async () => {
    const { calls } = mockRoutes({
      "GET /api/vaults/sample/files": tree,
      "GET /api/vaults/sample/search?q=plan&limit=30": () =>
        page([
          {
            path: "Plan.md",
            titleMatch: true,
            matches: [{ line: 3, text: "The plan for next week" }],
          },
        ]),
    });
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    expect(screen.getByText(/Type to search/)).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "plan");
    const list = await screen.findByRole("list", { name: "Search results" });
    expect(screen.getByText("Results: 1")).toBeInTheDocument();
    const marks = [...list.querySelectorAll("mark")].map((m) => m.textContent);
    expect(marks).toEqual(["Plan", "plan"]);
    // One request for the whole word, not one per keystroke.
    expect(calls.filter((c) => c.url.includes("/search?")).length).toBe(1);

    await user.click(within(list).getByRole("button", { name: /Plan\.md/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Plan.md" })).toBeInTheDocument();
  });

  it("shows when nothing matches and translated errors", async () => {
    mockRoutes({
      "GET /api/vaults/sample/files": tree,
      "GET /api/vaults/sample/search?q=zzz&limit=30": () => page([]),
      "GET /api/vaults/sample/search?q=boom&limit=30": () =>
        Response.json({ code: "unavailable", message: "x" }, { status: 503 }),
    });
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    const box = screen.getByRole("searchbox", { name: "Search" });
    await user.type(box, "zzz");
    expect(await screen.findByText("No results for “zzz”.")).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "boom");
    expect(await screen.findByText("The service is temporarily unavailable.")).toBeInTheDocument();
  });

  it("loads more results and escapes Chinese queries in the address", async () => {
    const hit = (n: number) => ({ path: `n${n}.md`, titleMatch: false, matches: [] });
    // Build the expected addresses from URLSearchParams, as the client does.
    const first = `/api/vaults/sample/search?${new URLSearchParams({ q: "決策", limit: "30" })}`;
    const second = `/api/vaults/sample/search?${new URLSearchParams({ q: "決策", offset: "2", limit: "30" })}`;
    mockRoutes({
      "GET /api/vaults/sample/files": tree,
      [`GET ${first}`]: () => page([hit(1), hit(2)], 3),
      [`GET ${second}`]: () => page([hit(3)], 3, 2),
    });
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "決策");
    expect(await screen.findByText("Results: 3")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("opens the search with Ctrl+Shift+F, even with the sidebar hidden", async () => {
    mockRoutes({ "GET /api/vaults/sample/files": tree });
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Hide sidebar" }));
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    const box = await screen.findByRole("searchbox", { name: "Search" });
    await waitFor(() => expect(box).toHaveFocus());
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("aria-pressed", "true");
  });

  it("is translated", async () => {
    mockRoutes({ "GET /api/vaults/sample/files": tree });
    const user = userEvent.setup();
    await renderRoute("/v/sample", "zh-TW");
    await user.click(await screen.findByRole("button", { name: "搜尋" }));
    expect(screen.getByRole("searchbox", { name: "搜尋" })).toHaveAttribute(
      "placeholder",
      "搜尋名稱與內容…",
    );
  });
});

describe("links of the open file", () => {
  it("lists backlinks with their lines and the file's own links", async () => {
    mockRoutes({
      "GET /api/vaults/sample/files": tree,
      "GET /api/vaults/sample/files/Plan.md": () =>
        Response.json({
          path: "Plan.md",
          content: "See [[Home]] and [[Ghost]]",
          mtime: 1,
          version: "v",
        }),
      "GET /api/vaults/sample/backlinks?path=Plan.md": () =>
        Response.json({
          backlinks: [{ path: "docs/Index.md", lines: [{ line: 2, text: "Read [[Plan]] first" }] }],
        }),
      "GET /api/vaults/sample/links?path=Plan.md": () =>
        Response.json({
          links: [
            { target: "Home", path: "Home.md", embed: false },
            { target: "Ghost", path: null, embed: false },
          ],
        }),
    });
    const user = userEvent.setup();
    await renderRoute("/v/sample/Plan.md");
    await user.click(await screen.findByRole("button", { name: "Show details panel" }));
    const panel = await screen.findByRole("region", { name: "Links" });
    expect(within(panel).getByText("Linked from (1)")).toBeInTheDocument();
    expect(within(panel).getByText("Read [[Plan]] first")).toBeInTheDocument();
    expect(within(panel).getByText("Links to (2)")).toBeInTheDocument();
    expect(within(panel).getByText("Ghost")).toBeInTheDocument();
    expect(within(panel).getByText("not found")).toBeInTheDocument();
    // An unresolved link is not a button.
    expect(within(panel).queryByRole("button", { name: /Ghost/ })).toBeNull();

    await user.click(within(panel).getByRole("button", { name: /Home\.md/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Home.md" })).toBeInTheDocument();
  });

  it("says so when nothing links anywhere", async () => {
    mockRoutes({
      "GET /api/vaults/sample/backlinks?path=a.md": () => Response.json({ backlinks: [] }),
      "GET /api/vaults/sample/links?path=a.md": () => Response.json({ links: [] }),
    });
    await renderWithProviders(
      <BacklinksPanel vault="sample" path="a.md" revision={0} onOpen={() => {}} />,
    );
    expect(await screen.findByText("No other file links here.")).toBeInTheDocument();
    expect(screen.getByText("This file has no links.")).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    let fail = true;
    mockRoutes({
      "GET /api/vaults/sample/backlinks?path=a.md": () =>
        fail
          ? Response.json({ code: "unavailable", message: "x" }, { status: 503 })
          : Response.json({ backlinks: [] }),
      "GET /api/vaults/sample/links?path=a.md": () => Response.json({ links: [] }),
    });
    const user = userEvent.setup();
    await renderWithProviders(
      <BacklinksPanel vault="sample" path="a.md" revision={0} onOpen={() => {}} />,
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("This file has no links.")).toBeInTheDocument();
  });
});
