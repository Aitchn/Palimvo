import { expect, test } from "@playwright/test";
import { mockApi } from "./mocks.ts";

test("the manifest is complete and its icons exist", async ({ page, request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: "Palimvo",
    short_name: "Palimvo",
    display: "standalone",
    start_url: "/",
  });
  const sizes = manifest.icons.map(
    (icon: { sizes: string; purpose: string }) => `${icon.sizes}/${icon.purpose}`,
  );
  expect(sizes).toEqual(expect.arrayContaining(["192x192/any", "512x512/any", "512x512/maskable"]));
  for (const icon of manifest.icons as { src: string; type: string }[]) {
    const file = await request.get(icon.src);
    expect(file.ok(), icon.src).toBe(true);
    expect(file.headers()["content-type"], icon.src).toContain(icon.type);
  }
  await page.goto("/");
});

test("the browser considers the app installable and the worker takes control", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  // Playwright's browser contexts are always incognito, which Chrome reports as its own reason.
  expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);
});

test("only the app shell is cached, never /api, /mcp or /oauth", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("link", { name: /sample/ }).waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  const urls = await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys())
        out.push(new URL(request.url).pathname);
    }
    return out;
  });
  expect(urls).toContain("/index.html");
  expect(urls.filter((path) => /^\/(api|mcp|oauth)(\/|$)/.test(path))).toEqual([]);
});

test("offline, the shell still opens and says so", async ({ page, context }) => {
  await mockApi(page);
  await page.goto("/v/sample");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByText("You are offline")).toBeVisible();
});
