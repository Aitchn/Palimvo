import { expect, test } from "@playwright/test";
import { mockApi, shotPath } from "./mocks.ts";

const SIZES = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;

const TEXT = {
  en: { home: "Your vaults", empty: "Home", menu: "Open menu" },
  "zh-TW": { home: "你的筆記庫", empty: "首頁", menu: "開啟選單" },
} as const;

// Each case is also written to tests/e2e/screenshots/ and uploaded by CI as an artifact.
for (const [size, viewport] of Object.entries(SIZES)) {
  for (const scheme of ["light", "dark"] as const) {
    for (const locale of ["en", "zh-TW"] as const) {
      test.describe(`${size} ${scheme} ${locale}`, () => {
        // Reduced motion makes entrance animations instant, so screenshots never catch a panel mid-slide.
        test.use({ viewport, colorScheme: scheme, locale, reducedMotion: "reduce" });

        test("vault list", async ({ page }) => {
          await mockApi(page);
          await page.goto("/");
          await expect(page.getByRole("heading", { level: 1 })).toHaveText(TEXT[locale].home);
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
          await page.getByRole("link", { name: /sample/ }).waitFor();
          await page.screenshot({ path: shotPath(`${size}-${scheme}-${locale}-home`) });
        });

        test("workspace", async ({ page }) => {
          await mockApi(page);
          await page.goto("/v/sample");
          await expect(page.getByRole("main")).toContainText(TEXT[locale].empty);
          if (size === "mobile") {
            await page.getByRole("button", { name: TEXT[locale].menu }).click();
            await expect(page.getByText("Welcome.md")).toBeVisible();
          } else {
            await expect(page.getByText("Welcome.md")).toBeVisible();
          }
          await page.screenshot({ path: shotPath(`${size}-${scheme}-${locale}-workspace`) });
          // Nothing pushes the page wider than the screen.
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
        });
      });
    }
  }
}

test.describe("language and theme switches", () => {
  test.use({ viewport: SIZES.desktop, colorScheme: "light", locale: "en" });

  test("take effect at once and survive a reload", async ({ page }) => {
    await mockApi(page);
    await page.goto("/v/sample");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Interface language").selectOption("zh-TW");
    await expect(page.getByRole("dialog", { name: "設定" })).toBeVisible();
    await page.getByRole("radio", { name: "深色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("main")).toContainText("首頁");
  });

  test("download only the language in use", async ({ page }) => {
    const chunks: string[] = [];
    page.on("request", (request) => {
      const match = /\/assets\/(en|zh-TW|zh-CN)-[\w-]+\.js$/.exec(request.url());
      if (match) chunks.push(match[1] as string);
    });
    await mockApi(page);
    await page.goto("/");
    await page.getByRole("link", { name: /sample/ }).waitFor();
    expect(chunks).toEqual(["en"]);
  });

  test("an old aitchn.theme choice is picked up and moved", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("aitchn.theme", "dark"));
    await mockApi(page);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect
      .poll(() =>
        page.evaluate(() => [
          localStorage.getItem("palimvo.theme"),
          localStorage.getItem("aitchn.theme"),
        ]),
      )
      .toEqual(["dark", null]);
  });
});
