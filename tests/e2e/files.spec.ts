import { expect, test } from "@playwright/test";
import { mockApi, shotPath } from "./mocks.ts";

test.describe("files on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  test("open a file from the tree, reload it from its address, find another with Ctrl+P", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/v/sample");
    await page.getByRole("treeitem", { name: /^Projects/ }).click();
    await page.getByRole("treeitem", { name: /^Roadmap.md/ }).click();
    await expect(page).toHaveURL(/\/v\/sample\/Projects\/Roadmap\.md$/);
    await expect(page.getByRole("article")).toContainText("Text of Projects/Roadmap.md");
    await expect(page.getByRole("tab", { name: "Roadmap" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.screenshot({ path: shotPath("files-desktop-open") });

    // The address alone is enough to come back to the same place.
    await page.reload();
    await expect(page.getByRole("article")).toContainText("Text of Projects/Roadmap.md");
    await expect(page.getByRole("treeitem", { name: /^Roadmap.md/ })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.keyboard.press("Control+p");
    await expect(page.getByRole("combobox", { name: "Quick open" })).toBeFocused();
    await page.keyboard.type("wel");
    await page.screenshot({ path: shotPath("files-desktop-quick-open") });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/v\/sample\/Welcome\.md$/);
    await expect(page.getByRole("tab")).toHaveCount(2);
  });

  test("right-click shows the folder menu", async ({ page }) => {
    await mockApi(page);
    await page.goto("/v/sample");
    await page.getByRole("treeitem", { name: /^Projects/ }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Download as ZIP" })).toBeVisible();
    await page.screenshot({ path: shotPath("files-desktop-context-menu") });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});

test.describe("files on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", hasTouch: true });

  test("the tree is a drawer; choosing a file closes it", async ({ page }) => {
    await mockApi(page);
    await page.goto("/v/sample");
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("treeitem", { name: /^Welcome.md/ })).toBeVisible();
    await page.screenshot({ path: shotPath("files-mobile-drawer") });
    await page.getByRole("treeitem", { name: /^Welcome.md/ }).tap();
    await expect(page.getByRole("dialog", { name: "Files" })).toHaveCount(0);
    await expect(page.getByRole("article")).toContainText("Text of Welcome.md");
    await page.screenshot({ path: shotPath("files-mobile-open") });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
