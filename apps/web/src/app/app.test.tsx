import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.ts";
import { mockFetch, mockMatchMedia, renderRoute } from "../test/render.tsx";

const vaults = () => Response.json({ vaults: [{ id: "sample", name: "sample" }] });
const tree = () =>
  Response.json({
    tree: [
      {
        name: "Projects",
        path: "Projects",
        type: "folder",
        children: [{ name: "Plan.md", path: "Projects/Plan.md", type: "file", kind: "markdown" }],
      },
      { name: "Welcome.md", path: "Welcome.md", type: "file", kind: "markdown" },
    ],
  });

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
});

describe("vault list", () => {
  it("lists vaults and links to the workspace", async () => {
    mockFetch({ "/api/vaults": vaults });
    await renderRoute("/");
    const link = await screen.findByRole("link", { name: "Open sample" });
    expect(link).toHaveAttribute("href", "/v/sample");
    expect(screen.getByRole("heading", { level: 1, name: "Your vaults" })).toBeInTheDocument();
  });

  it("shows a translated error with a retry that works", async () => {
    let fail = true;
    mockFetch({
      "/api/vaults": () =>
        fail ? Response.json({ code: "unavailable", message: "x" }, { status: 503 }) : vaults(),
    });
    const user = userEvent.setup();
    await renderRoute("/", "zh-TW");
    expect(await screen.findByRole("alert")).toHaveTextContent("服務暫時無法使用。");
    fail = false;
    await user.click(screen.getByRole("button", { name: "重試" }));
    expect(await screen.findByRole("link", { name: "開啟 sample" })).toBeInTheDocument();
  });

  it("switches language at once and keeps the choice", async () => {
    mockFetch({ "/api/vaults": vaults });
    const user = userEvent.setup();
    await renderRoute("/");
    await screen.findByRole("link", { name: "Open sample" });
    await user.selectOptions(screen.getByLabelText("Interface language"), "zh-CN");
    expect(
      await screen.findByRole("heading", { level: 1, name: "你的笔记库" }),
    ).toBeInTheDocument();
    expect(localStorage.getItem("palimvo.locale")).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});

describe("unknown address", () => {
  it("shows a not-found page with a way back", async () => {
    mockFetch({});
    await renderRoute("/nowhere/at/all");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to your vaults" })).toHaveAttribute("href", "/");
  });
});

describe("workspace on a wide screen", () => {
  beforeEach(() => {
    mockFetch({ "/api/vaults/sample/files": tree });
  });

  it("shows rail, sidebar with the tree, main and no details panel by default", async () => {
    await renderRoute("/v/sample");
    const sidebar = await screen.findByRole("complementary", { name: "Files" });
    expect(await within(sidebar).findByText("Welcome.md")).toBeInTheDocument();
    expect(within(sidebar).getByText("Plan.md")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("No file open");
    expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
  });

  it("collapses the sidebar, opens the details panel, and remembers both", async () => {
    const user = userEvent.setup();
    const first = await renderRoute("/v/sample");
    await screen.findByRole("complementary", { name: "Files" });
    await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Files" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show details panel" }));
    expect(screen.getByRole("complementary", { name: "Details" })).toBeInTheDocument();
    first.unmount();

    await renderRoute("/v/sample");
    expect(await screen.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Files" })).toBeNull();
  });

  it("changes theme and language from the settings dialog", async () => {
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.selectOptions(within(dialog).getByLabelText("Interface language"), "zh-TW");
    expect(await screen.findByRole("dialog", { name: "設定" })).toBeInTheDocument();
  });

  it("changes theme from the rail menu", async () => {
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Theme" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("palimvo.theme")).toBe("light");
  });

  it("shows a translated error when the tree cannot be loaded", async () => {
    mockFetch({
      "/api/vaults/sample/files": () =>
        Response.json({ code: "vault_not_found", message: "x" }, { status: 404 }),
    });
    await renderRoute("/v/sample", "zh-TW");
    expect(await screen.findByRole("alert")).toHaveTextContent("這個筆記庫不存在。");
  });
});

describe("workspace on a phone", () => {
  beforeEach(() => {
    mockMatchMedia(true);
    mockFetch({ "/api/vaults/sample/files": tree });
  });

  it("keeps panels closed, opens the file drawer from the menu button and closes it with Escape", async () => {
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Open menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Files" });
    expect(await within(drawer).findByText("Welcome.md")).toBeInTheDocument();
    expect(within(drawer).getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the details panel as a drawer from the right", async () => {
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Show details panel" }));
    expect(await screen.findByRole("dialog", { name: "Details" })).toHaveClass("sheet-right");
  });

  it("turns the settings dialog into a bottom sheet host (same dialog, narrow CSS)", async () => {
    const user = userEvent.setup();
    await renderRoute("/v/sample");
    await user.click(await screen.findByRole("button", { name: "Open menu" }));
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    // The drawer closed behind it.
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
  });
});
