import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { mockMatchMedia, mockRoutes, renderWithProviders } from "../test/render.tsx";
import { initTheme } from "../theme/theme.ts";
import { FileViewer } from "./FileViewer.tsx";

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
  window.URL.createObjectURL = () => "blob:svg";
  window.URL.revokeObjectURL = () => {};
});

const raw = (path: string, body: string, init: ResponseInit = {}) => ({
  [`GET /api/vaults/v/raw/${path}`]: () => new Response(body, init),
});

describe("file viewer", () => {
  it("shows a picture, with a download that asks to save", async () => {
    await renderWithProviders(<FileViewer vault="v" path="pics/cat one.png" />);
    const img = screen.getByAltText("pics/cat one.png");
    expect(img).toHaveAttribute("src", "/api/vaults/v/raw/pics/cat%20one.png");
    const link = screen.getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", "/api/vaults/v/raw/pics/cat%20one.png?download=1");
    expect(link).toHaveAttribute("download", "cat one.png");
  });

  it("plays audio and video and embeds a PDF from the raw route", async () => {
    const { container, unmount } = await renderWithProviders(<FileViewer vault="v" path="a.mp3" />);
    expect(container.querySelector("audio")).toHaveAttribute("src", "/api/vaults/v/raw/a.mp3");
    unmount();
    const video = await renderWithProviders(<FileViewer vault="v" path="a.mp4" />);
    expect(video.container.querySelector("video")?.controls).toBe(true);
    video.unmount();
    await renderWithProviders(<FileViewer vault="v" path="doc.pdf" />);
    expect(screen.getByTitle("doc.pdf")).toHaveAttribute("src", "/api/vaults/v/raw/doc.pdf");
  });

  it("offers only the download for a type with no viewer", async () => {
    await renderWithProviders(<FileViewer vault="v" path="tune.nbs" />);
    expect(screen.getByText(/no built-in view for \.nbs files/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download" })).toBeInTheDocument();
  });

  it("shows JSON as a tree that can be switched to text", async () => {
    mockRoutes(
      raw("d.json", JSON.stringify({ name: "Palimvo", tags: ["a", "b"], deep: { n: 1 } })),
    );
    await renderWithProviders(<FileViewer vault="v" path="d.json" />);
    const tree = await screen.findByRole("tree");
    expect(within(tree).getByText("name")).toBeInTheDocument();
    expect(within(tree).getByText('"Palimvo"')).toBeInTheDocument();
    expect(within(tree).getByText("[2]")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Show as text"));
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toContain('"name"');
  });

  it("falls back to text for JSON that does not parse", async () => {
    mockRoutes(raw("bad.json", "{ nope"));
    await renderWithProviders(<FileViewer vault="v" path="bad.json" />);
    expect(await screen.findByText("Not valid JSON, so it is shown as text.")).toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toBe("{ nope");
  });

  it("shows CSV as a table with a header row", async () => {
    mockRoutes(raw("t.csv", 'name,qty\n"Apple, red",3\nPear,5\n'));
    await renderWithProviders(<FileViewer vault="v" path="t.csv" />);
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["name", "qty"]);
    expect(within(table).getByText("Apple, red")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("shows YAML and plain text as they are", async () => {
    mockRoutes({ ...raw("c.yaml", "key: value\n"), ...raw("n.txt", "hello") });
    const { unmount } = await renderWithProviders(<FileViewer vault="v" path="c.yaml" />);
    await waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("key: value\n"));
    unmount();
    await renderWithProviders(<FileViewer vault="v" path="n.txt" />);
    await waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("hello"));
  });

  it("says when a text file is empty, too big or missing", async () => {
    mockRoutes({
      ...raw("e.txt", ""),
      ...raw("big.txt", "x", { headers: { "content-length": String(6 * 1024 * 1024) } }),
    });
    const empty = await renderWithProviders(<FileViewer vault="v" path="e.txt" />);
    expect(await screen.findByText("This file is empty.")).toBeInTheDocument();
    empty.unmount();
    const big = await renderWithProviders(<FileViewer vault="v" path="big.txt" />);
    expect(await screen.findByText(/6\.0 MiB, too large to show here/)).toBeInTheDocument();
    big.unmount();
    await renderWithProviders(<FileViewer vault="v" path="gone.txt" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be found");
  });

  it("draws an SVG as a picture, never as markup", async () => {
    mockRoutes(
      raw("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    );
    const { container } = await renderWithProviders(<FileViewer vault="v" path="logo.svg" />);
    await waitFor(() => expect(container.querySelector("img")).toHaveAttribute("src", "blob:svg"));
    expect(container.querySelector(".media-viewer svg, script")).toBeNull();
  });
});
