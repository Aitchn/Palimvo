import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, shotPath } from "./mocks.ts";

// The official calendar plugin in a real browser: it runs in the sandboxed plugin frame, so
// clicking a day and dragging a note go through the plugin bridge to the (fake) server.

const dir = fileURLToPath(new URL("../../plugins/calendar/", import.meta.url));
const read = (file: string) => readFileSync(`${dir}${file}`, "utf8");
const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;
const files: Record<string, string> = { "main.js": read("main.js") };
for (const path of Object.values(manifest.locales as Record<string, string>))
  files[path] = read(path);
const HASH = "d".repeat(64);

async function serve(page: Page, vault: Map<string, string>, writes: string[]) {
  await mockApi(page);
  await page.clock.setFixedTime(new Date(2026, 2, 18, 12));
  await page.route("**/api/vaults/sample/plugin-runtime", (route) =>
    route.fulfill({
      json: {
        plugins: [{ id: "calendar", version: "1.0.0", hash: HASH, manifest }],
      },
    }),
  );
  await page.route("**/api/vaults/sample/plugin-runtime/calendar", (route) =>
    route.fulfill({ json: { id: "calendar", hash: HASH, files } }),
  );
  await page.route("**/api/vaults/sample/files", (route) =>
    route.fulfill({
      json: {
        tree: [...vault.keys()].map((path) => ({
          name: path,
          path,
          type: "file",
          kind: "markdown",
        })),
      },
    }),
  );
  await page.route("**/api/vaults/sample/files/**", async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname).split("/files/")[1]!;
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { content: string };
      vault.set(path, body.content);
      writes.push(path);
      return route.fulfill({ json: { path, mtime: 2, version: "v2" } });
    }
    const content = vault.get(path);
    return content === undefined
      ? route.fulfill({ status: 404, json: { code: "not_found", message: "no" } })
      : route.fulfill({ json: { path, content, mtime: 1, version: "v1" } });
  });
}

test.use({ viewport: { width: 1280, height: 800 }, locale: "en", colorScheme: "light" });

test("shows notes by property and file name, creates a note and drags one to a new date", async ({
  page,
}) => {
  const vault = new Map([
    ["Plan.md", "---\ndate: 2026-03-18\n---\nPlan"],
    ["2026-03-05 Trip.md", "A trip"],
    ["Undated.md", "nothing"],
  ]);
  const writes: string[] = [];
  await serve(page, vault, writes);
  await page.goto("/v/sample?plugin=calendar&view=calendar");
  const frame = page.frameLocator('.plugin-host[data-plugin="calendar"] iframe');

  await expect(frame.locator('[data-day="2026-03-18"]')).toContainText("Plan");
  await expect(frame.locator('[data-day="2026-03-05"]')).toContainText("2026-03-05 Trip");
  await expect(frame.locator(".cal-count")).toHaveText("2 dated notes");
  await page.screenshot({ path: shotPath("calendar-month") });

  // Create a note on a day.
  await frame.locator('[data-day="2026-03-20"]').hover();
  await frame.getByRole("button", { name: "New note on 2026-03-20" }).click();
  await expect
    .poll(() => vault.get("2026-03-20.md"))
    .toBe("---\ndate: 2026-03-20\n---\n\n# 2026-03-20\n");
  // The new note is opened, which leaves the calendar page; come back to it.
  await expect(page).toHaveURL(/2026-03-20\.md/);
  await page.goto("/v/sample?plugin=calendar&view=calendar");
  await expect(frame.locator('[data-day="2026-03-20"]')).toContainText("2026-03-20");

  // Drag Plan onto another day: only the date line changes.
  await frame
    .locator('[data-day="2026-03-18"] .cal-note')
    .dragTo(frame.locator('[data-day="2026-03-25"]'));
  await expect.poll(() => vault.get("Plan.md")).toBe("---\ndate: 2026-03-25\n---\nPlan");
  await expect(frame.locator('[data-day="2026-03-25"]')).toContainText("Plan");
  await expect(frame.locator('[data-day="2026-03-18"]')).not.toContainText("Plan");

  // Week view.
  await frame.getByRole("button", { name: "Week", exact: true }).click();
  await expect(frame.locator(".cal-day")).toHaveCount(7);
  await page.screenshot({ path: shotPath("calendar-week") });
});

test("uses the Traditional Chinese strings when the app is in that language", async ({ page }) => {
  await serve(page, new Map([["Plan.md", "---\ndate: 2026-03-18\n---\n"]]), []);
  await page.addInitScript(() => localStorage.setItem("palimvo.locale", "zh-TW"));
  await page.goto("/v/sample?plugin=calendar&view=calendar");
  const frame = page.frameLocator('.plugin-host[data-plugin="calendar"] iframe');
  await expect(frame.getByRole("button", { name: "今天" })).toBeVisible();
  await expect(frame.locator(".cal-count")).toHaveText("1 篇有日期的筆記");
});
