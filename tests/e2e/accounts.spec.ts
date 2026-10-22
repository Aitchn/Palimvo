import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// The whole flow runs against the real built server (`pnpm build` first), not a mock.
const SERVER = fileURLToPath(new URL("../../apps/server/dist/palimvo.mjs", import.meta.url));
const WEB = fileURLToPath(new URL("../../apps/web/dist", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess;
let dataDir: string;
let base: string;

test.beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "palimvo-e2e-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [
      SERVER,
      "serve",
      "--data-dir",
      dataDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--web-dir",
      WEB,
    ],
    { stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The server did not start.");
});

test.afterAll(async () => {
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("fresh install: wizard, first vault, invite a reader who cannot edit", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);

  // 1. A new server sends everyone to the wizard.
  await page.goto(base);
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Display name").fill("Ada");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Password again").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Vault name").fill("notes");
  await page.getByRole("button", { name: "Finish setup" }).click();

  // 2. The administrator lands in the new vault and can create things.
  await expect(page).toHaveURL(/\/v\/notes/);
  await expect(page.getByRole("button", { name: "New note" })).toBeVisible();

  // 3. They invite a second person into the vault with the Reader role.
  await page.goto(`${base}/settings/users`);
  await page.getByRole("button", { name: "Invite people" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("notes").check();
  await dialog.getByLabel("Reader").check();
  await dialog.getByRole("button", { name: "Create invite link" }).click();
  const link = await dialog.getByLabel("Invite link").inputValue();
  expect(link).toContain("/invite/");

  // 4. The invited person makes an account in a separate browser and cannot edit anything.
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(link.replace(/^https?:\/\/[^/]+/, base));
  await guest.getByLabel("Username").fill("bo");
  await guest.getByLabel("Password", { exact: true }).fill("another long password");
  await guest.getByLabel("Password again").fill("another long password");
  await guest.getByRole("button", { name: "Create my account" }).click();
  await expect(guest).toHaveURL(/\/v\/notes/);
  await guest.getByRole("treeitem", { name: /^Welcome/ }).click();
  await expect(guest.getByText("View only")).toBeVisible();
  await expect(guest.getByRole("button", { name: "New note" })).toHaveCount(0);
  await expect(guest.getByRole("button", { name: "New folder" })).toHaveCount(0);

  // The server agrees with the screen: a write is refused.
  const refused = await guest.evaluate(async () => {
    const me = await (await fetch("/api/auth/me")).json();
    const response = await fetch("/api/vaults/notes/files/Nope.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Palimvo-Csrf": me.csrfToken },
      body: JSON.stringify({ content: "x" }),
    });
    return response.status;
  });
  expect(refused).toBe(403);
  await context.close();
});
