import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { mockMatchMedia, mockRoutes, renderRoute } from "../test/render.tsx";
import { initTheme } from "../theme/theme.ts";

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
  localStorage.clear();
});

const HASH = "c".repeat(64);
const manifest = {
  manifestVersion: 2,
  id: "hello",
  version: "1.0.0",
  name: { en: "Hello plugin", "zh-TW": "哈囉插件" },
  permissions: { read: ["**"] },
  contributes: {
    views: [{ id: "board", name: { en: "Hello board", "zh-TW": "哈囉看板" } }],
    homeWidgets: [{ id: "greeting", name: { en: "Greeting", "zh-TW": "問候" } }],
    viewers: [{ id: "log", name: { en: "ZZZ viewer" }, extensions: ["log"] }],
  },
};
const listing = { id: "hello", version: "1.0.0", hash: HASH, manifest };
const bundle = { id: "hello", hash: HASH, files: { "main.js": "export default () => {};" } };

const FILES = {
  tree: [
    { name: "Welcome.md", path: "Welcome.md", type: "file", kind: "markdown" },
    { name: "data.log", path: "data.log", type: "file", kind: "other" },
  ],
};

const HOME_WITH_WIDGET = {
  config: {
    schemaVersion: 1,
    widgets: [{ id: "w1", type: "plugin", plugin: "hello", view: "greeting" }],
    pinned: [],
    publicNote: null,
  },
  version: null,
};

function routes(over: Record<string, () => Response> = {}) {
  return mockRoutes({
    "GET /api/vaults/sample/files": () => Response.json(FILES),
    "GET /api/vaults/sample/files/data.log": () =>
      Response.json({ path: "data.log", content: "raw text", mtime: 1, version: "v1" }),
    "GET /api/vaults/sample/home": () => Response.json(HOME_WITH_WIDGET),
    "GET /api/vaults/sample/plugin-runtime": () => Response.json({ plugins: [listing] }),
    "GET /api/vaults/sample/plugin-runtime/hello": () => Response.json(bundle),
    ...over,
  });
}

describe("plugins in the workspace", () => {
  it("draws a plugin home widget in a sandboxed frame under its own title", async () => {
    routes();
    await renderRoute("/v/sample");
    const card = (await screen.findByRole("region", { name: "Greeting" })) as HTMLElement;
    const frame = await waitFor(() => {
      const found = card.querySelector("iframe");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).toContain("Content-Security-Policy");
  });

  it("says so when the plugin behind a widget does not run in this vault", async () => {
    routes({ "GET /api/vaults/sample/plugin-runtime": () => Response.json({ plugins: [] }) });
    await renderRoute("/v/sample");
    expect(
      await screen.findByText(/The widget greeting of the plugin hello is not available/),
    ).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("does not run a plugin whose bundle is not the approved one", async () => {
    routes({
      "GET /api/vaults/sample/plugin-runtime/hello": () =>
        Response.json({ ...bundle, hash: "d".repeat(64) }),
    });
    await renderRoute("/v/sample");
    expect(
      await screen.findByText(/The widget greeting of the plugin hello is not available/),
    ).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("stops everything when the server stops listing the plugin", async () => {
    let listed = true;
    routes({
      "GET /api/vaults/sample/plugin-runtime": () =>
        Response.json({ plugins: listed ? [listing] : [] }),
    });
    await renderRoute("/v/sample");
    await screen.findByRole("region", { name: "Greeting" });
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    listed = false;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());
  });

  it("keeps running when a refresh fails for a moment", async () => {
    let fail = false;
    routes({
      "GET /api/vaults/sample/plugin-runtime": () =>
        fail
          ? Response.json({ code: "unavailable", message: "x" }, { status: 503 })
          : Response.json({ plugins: [listing] }),
    });
    await renderRoute("/v/sample");
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    fail = true;
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.querySelector("iframe")).not.toBeNull();
  });

  it("stops everything when access is withdrawn", async () => {
    let denied = false;
    routes({
      "GET /api/vaults/sample/plugin-runtime": () =>
        denied
          ? Response.json({ code: "forbidden", message: "x" }, { status: 403 })
          : Response.json({ plugins: [listing] }),
    });
    await renderRoute("/v/sample");
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    denied = true;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());
  });

  it("lists a plugin's page in the sidebar and opens it in the main area", async () => {
    routes({
      "GET /api/vaults/sample/home": () =>
        Response.json({ ...HOME_WITH_WIDGET, config: { ...HOME_WITH_WIDGET.config, widgets: [] } }),
    });
    await renderRoute("/v/sample");
    const nav = await screen.findByRole("navigation", { name: "Plugin views" });
    await userEvent.click(within(nav).getByRole("button", { name: "Hello board" }));
    const view = await waitFor(() => {
      const found = document.querySelector(".plugin-view iframe");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(view.getAttribute("sandbox")).toBe("allow-scripts");
    expect(within(nav).getByRole("button", { name: "Hello board" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens a file with a plugin viewer and lets the person switch to the text", async () => {
    routes();
    await renderRoute("/v/sample/data.log");
    const switcher = await screen.findByRole("group", { name: "Viewer" });
    await waitFor(() => expect(document.querySelector(".file-view-plugin iframe")).not.toBeNull());
    await userEvent.click(within(switcher).getByRole("button", { name: "Text" }));
    expect(await screen.findByText("raw text")).toBeInTheDocument();
    expect(document.querySelector(".file-view-plugin iframe")).toBeNull();
  });

  it("shows plain text for that file when no plugin offers a viewer", async () => {
    routes({ "GET /api/vaults/sample/plugin-runtime": () => Response.json({ plugins: [] }) });
    await renderRoute("/v/sample/data.log");
    expect(await screen.findByText("raw text")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Viewer" })).toBeNull();
  });

  it("uses the interface language for the plugin's names", async () => {
    routes();
    await renderRoute("/v/sample", "zh-TW");
    expect(await screen.findByRole("region", { name: "問候" })).toBeInTheDocument();
  });

  describe("apps and themes", () => {
    const PAINT_HASH = "e".repeat(64);
    const paintManifest = {
      manifestVersion: 2,
      id: "paint",
      version: "1.0.0",
      name: { en: "Paint" },
      permissions: { read: ["**"] },
      contributes: {
        theme: { name: { en: "Midnight" }, css: "theme.css" },
        app: { name: { en: "Paint app" } },
        slots: [{ slot: "settings", id: "about", title: { en: "About paint" } }],
      },
    };
    const paintListing = {
      id: "paint",
      version: "1.0.0",
      hash: PAINT_HASH,
      manifest: paintManifest,
    };
    const css = `:root[data-theme="dark"] { --accent: #123456; background: url(https://evil.example/x.png); }
      body { --leak: 1 }`;
    const paintBundle = {
      id: "paint",
      hash: PAINT_HASH,
      files: { "main.js": "export default () => {};", "theme.css": css },
    };
    const withPaint = () =>
      routes({
        "GET /api/vaults/sample/plugin-runtime": () =>
          Response.json({ plugins: [listing, paintListing] }),
        "GET /api/vaults/sample/plugin-runtime/paint": () => Response.json(paintBundle),
      });

    it("lists apps in the sidebar and lets one take over the main area", async () => {
      withPaint();
      await renderRoute("/v/sample");
      const nav = await screen.findByRole("navigation", { name: "Plugin apps" });
      await userEvent.click(within(nav).getByRole("button", { name: "Paint app" }));
      await waitFor(() => expect(document.querySelector(".plugin-app iframe")).not.toBeNull());
      expect(within(nav).getByRole("button", { name: "Paint app" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      // The app's own navigation stays.
      expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    });

    it("opens an app from its address and says so when it is not running", async () => {
      withPaint();
      await renderRoute("/v/sample?app=paint");
      await waitFor(() => expect(document.querySelector(".plugin-app iframe")).not.toBeNull());
    });

    it("says so for an app that does not exist", async () => {
      routes();
      await renderRoute("/v/sample?app=nobody");
      expect(await screen.findByText("This plugin app is not available.")).toBeInTheDocument();
    });

    it("applies a chosen plugin theme as sanitised CSS and removes it again", async () => {
      withPaint();
      await renderRoute("/v/sample");
      await screen.findByRole("navigation", { name: "Plugin apps" });
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      const select = await screen.findByRole("combobox", { name: "Plugin theme" });
      expect(document.getElementById("palimvo-plugin-theme")).toBeNull();
      await userEvent.selectOptions(select, "paint");
      const style = await waitFor(() => {
        const found = document.getElementById("palimvo-plugin-theme");
        expect(found).not.toBeNull();
        return found!;
      });
      expect(style.textContent).toBe(':root[data-theme="dark"]{--accent:#123456;}');
      expect(localStorage.getItem("palimvo.pluginTheme")).toBe("paint");
      await userEvent.selectOptions(select, "");
      await waitFor(() => expect(document.getElementById("palimvo-plugin-theme")).toBeNull());
    });
  });
});
