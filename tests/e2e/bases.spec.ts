import { expect, test, type Page } from "@playwright/test";
import { mockApi, shotPath } from "./mocks.ts";

const BASE =
  'filters:\n  and:\n    - file.inFolder("Tasks")\nviews:\n  - type: table\n    name: All\n    order:\n      - file.name\n      - status\n      - tags\n';

const result = (view: "table" | "cards") => ({
  views: [{ name: view === "table" ? "All" : "Board", type: view }],
  viewIndex: 0,
  view: { type: view, name: view === "table" ? "All" : "Board" },
  columns: [
    { id: "file.name", label: "Name", source: "file", key: "name" },
    { id: "status", label: "status", source: "note", key: "status" },
    { id: "file.tags", label: "Tags", source: "file", key: "tags" },
  ],
  rows: [
    {
      path: "Tasks/Write docs.md",
      cells: { "file.name": "Write docs", status: "open", "file.tags": ["task", "docs"] },
    },
    {
      path: "Tasks/Ship 0.1.md",
      cells: { "file.name": "Ship 0.1", status: "done", "file.tags": ["task"] },
    },
  ],
  groups: null,
  total: 2,
  errors: [],
  available: { properties: ["status"], tags: ["task", "docs"], folders: ["Tasks"], formulas: [] },
  version: "b1",
});

async function mockBase(page: Page) {
  const properties: unknown[] = [];
  await mockApi(page);
  await page.route("**/api/vaults/sample/files/Tasks.base", (route) =>
    route.fulfill({ json: { path: "Tasks.base", content: BASE, mtime: 1, version: "b1" } }),
  );
  await page.route("**/api/vaults/sample/bases/query", (route) =>
    route.fulfill({ json: result("table") }),
  );
  await page.route("**/api/vaults/sample/bases/property", (route) => {
    properties.push(route.request().postDataJSON());
    return route.fulfill({ json: { path: "Tasks/Write docs.md", version: "n2", mtime: 2 } });
  });
  return properties;
}

test.describe("databases on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  test("open a database, edit a cell, open the filter panel", async ({ page }) => {
    const properties = await mockBase(page);
    await page.goto("/v/sample/Tasks.base");
    const table = page.getByRole("table");
    await expect(table.getByRole("button", { name: "Write docs" })).toBeVisible();
    await expect(table.getByText("#docs")).toBeVisible();
    await page.screenshot({ path: shotPath("bases-desktop-table") });

    await table.getByTitle("Click to edit").first().click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("doing");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => properties)
      .toEqual([{ path: "Tasks/Write docs.md", key: "status", value: "doing" }]);

    await page.getByRole("button", { name: /^Filters/ }).click();
    await expect(page.getByText("In folder Tasks")).toBeVisible();
    await page.screenshot({ path: shotPath("bases-desktop-filters") });
  });

  test("the sidebar offers a wizard for a new database", async ({ page }) => {
    await mockBase(page);
    await page.goto("/v/sample");
    await page.getByRole("button", { name: "New database" }).click();
    const dialog = page.getByRole("dialog", { name: "New database" });
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Database");
    await page.screenshot({ path: shotPath("bases-desktop-wizard") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});

test.describe("databases on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", hasTouch: true });

  test("the table scrolls inside the page, never the page itself", async ({ page }) => {
    await mockBase(page);
    await page.goto("/v/sample/Tasks.base");
    await expect(page.getByRole("table").getByRole("button", { name: "Ship 0.1" })).toBeVisible();
    await page.screenshot({ path: shotPath("bases-mobile-table") });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
