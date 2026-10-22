import { expect, test, type Page } from "@playwright/test";

// The real server, not the fake API of the other specs (see playwright.config.ts).
const SERVER = "http://127.0.0.1:4174";
test.use({ baseURL: SERVER, viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

const body = (page: Page) => page.locator(".cm-content");
/** The note's text as typed, without the name tags that mark other people's cursors. */
const text = (page: Page) =>
  body(page).evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".cm-ySelectionCaret").forEach((caret) => caret.remove());
    return copy.textContent ?? "";
  });
const saved = (page: Page) => page.getByRole("status").filter({ hasText: "Saved" });

test("two browsers and an AI write to the same note and all three edits survive", async ({
  browser,
  request,
}) => {
  const vault = `collab-${Date.now()}`;
  expect((await request.post("/api/vaults", { data: { id: vault } })).ok()).toBe(true);
  const url = `/api/vaults/${vault}/files/Plan.md`;
  expect((await request.put(url, { data: { content: "alpha\n\nmiddle\n\nomega\n" } })).ok()).toBe(
    true,
  );

  // Two people, each in their own browser profile.
  const ada = await (await browser.newContext({ baseURL: SERVER })).newPage();
  const bo = await (await browser.newContext({ baseURL: SERVER })).newPage();
  for (const page of [ada, bo]) {
    await page.goto(`/v/${vault}/Plan.md`);
    await expect(body(page)).toContainText("middle");
    await expect(saved(page)).toBeVisible();
  }
  // Each sees the other.
  await expect(ada.getByText("2 people here")).toBeVisible();

  // Ada types at the top, Bo at the bottom, at the same moment.
  await body(ada).click();
  await ada.keyboard.press("Control+Home");
  await bo.locator(".cm-content").click();
  await bo.keyboard.press("Control+End");
  await Promise.all([ada.keyboard.type("ADA "), bo.keyboard.type(" BO")]);
  await expect.poll(() => text(bo)).toContain("ADA alpha");
  await expect.poll(() => text(ada)).toContain("omega BO");

  // An AI edits through the plain REST API, based on what it read a moment ago.
  const seen = await (await request.get(url)).json();
  const ai = await request.put(url, {
    headers: { "X-Palimvo-Author": "ai:Test AI", "X-Palimvo-Reason": "Clarify the middle" },
    data: {
      content: (seen.content as string).replace("middle", "middle (AI)"),
      baseVersion: seen.version,
    },
  });
  expect(ai.ok()).toBe(true);

  for (const page of [ada, bo]) {
    await expect.poll(() => text(page)).toBe("ADA alphamiddle (AI)omega BO");
  }
  await ada.screenshot({
    path: new URL("./screenshots/collab-desktop.png", import.meta.url).pathname,
  });

  // The file on disk (what Obsidian, git and the AIs see) has all three edits.
  await expect
    .poll(async () => (await (await request.get(url)).json()).content, { timeout: 10_000 })
    .toBe("ADA alpha\n\nmiddle (AI)\n\nomega\n BO");

  // A browser that opens the note later gets the merged text, not any one person's copy.
  const late = await (await browser.newContext({ baseURL: SERVER })).newPage();
  await late.goto(`/v/${vault}/Plan.md`);
  await expect.poll(() => text(late)).toBe("ADA alphamiddle (AI)omega BO");
});

test("a browser reconnects after the connection drops and keeps what was typed meanwhile", async ({
  browser,
  request,
}) => {
  const vault = `collab-drop-${Date.now()}`;
  await request.post("/api/vaults", { data: { id: vault } });
  const url = `/api/vaults/${vault}/files/Note.md`;
  await request.put(url, { data: { content: "start\n" } });

  const page = await (await browser.newContext({ baseURL: SERVER })).newPage();
  // Lets the live connection through until the test cuts it.
  let blocked = false;
  const open: { close(): Promise<void> | void }[] = [];
  await page.routeWebSocket(/\/api\/collab/, (ws) => {
    if (blocked) {
      void ws.close();
      return;
    }
    ws.connectToServer();
    open.push(ws);
  });
  await page.goto(`/v/${vault}/Note.md`);
  await expect(body(page)).toContainText("start");
  await expect(saved(page)).toBeVisible();

  blocked = true;
  await Promise.all(open.splice(0).map((ws) => ws.close()));
  await expect(page.getByRole("status").filter({ hasText: "Offline" })).toBeVisible();
  await body(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("typed while away");
  expect((await (await request.get(url)).json()).content).toBe("start\n");

  blocked = false;
  await expect
    .poll(async () => (await (await request.get(url)).json()).content, { timeout: 20_000 })
    .toBe("start\ntyped while away");
  await expect(saved(page)).toBeVisible({ timeout: 20_000 });
});
