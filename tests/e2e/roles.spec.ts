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

test("a Designer role may only write in design/, and its colour shows on its members", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);

  // 1. Set the server up and put a note in two folders.
  await page.goto(base);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Display name").fill("Ada");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Password again").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Vault name").fill("notes");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/v\/notes/);

  /** Calls the API as the signed-in page, with its CSRF token. */
  const api = (method: string, path: string, body?: unknown) =>
    page.evaluate(
      async ([m, p, b]) => {
        const me = await (await fetch("/api/auth/me")).json();
        const res = await fetch(p as string, {
          method: m as string,
          headers: { "Content-Type": "application/json", "X-Palimvo-Csrf": me.csrfToken },
          body: b === undefined ? undefined : JSON.stringify(b),
        });
        return { status: res.status, body: res.status === 204 ? null : await res.json() };
      },
      [method, path, body] as const,
    );
  expect(
    (await api("PUT", "/api/vaults/notes/files/design/a.md", { content: "design" })).status,
  ).toBe(200);
  expect(
    (await api("PUT", "/api/vaults/notes/files/other/b.md", { content: "other" })).status,
  ).toBe(200);
  const bo = await api("POST", "/api/admin/users", {
    username: "bo",
    password: "another long password",
    displayName: "Bo",
  });
  expect(bo.status).toBe(201);
  expect(
    (await api("PUT", `/api/vaults/notes/members/${bo.body.id}`, { position: "member" })).status,
  ).toBe(200);

  // 2. Make the Designer role, give it a colour, and give it to Bo.
  await page.goto(`${base}/settings/roles`);
  await page.getByLabel("New role name").fill("Designer");
  await page.getByRole("button", { name: "Create role" }).click();
  const editor = page.getByRole("form", { name: "Edit role Designer" });
  await editor.getByRole("radio", { name: "#c25aa8" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Role saved.")).toBeVisible();
  await page.getByLabel("Give this role to").selectOption({ label: "Bo (@bo)" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("list").filter({ hasText: "@bo" })).toBeVisible();

  // 3. In the vault the role may not write anywhere...
  await page.goto(`${base}/settings/vaults/notes`);
  await page.getByLabel("Add a rule for a role").selectOption({ label: "Designer" });
  const vaultWide = page.locator(".permission-editor").first();
  await vaultWide
    .getByRole("radiogroup", { name: "Write notes" })
    .getByRole("radio", { name: "Deny" })
    .click();
  await vaultWide
    .getByRole("radiogroup", { name: "Delete and rename notes" })
    .getByRole("radio", { name: "Deny" })
    .click();
  await vaultWide
    .getByRole("radiogroup", { name: "Upload files" })
    .getByRole("radio", { name: "Deny" })
    .click();

  // ...except in design/, which the folder's right-click menu opens.
  await page.goto(`${base}/v/notes`);
  await page.getByRole("treeitem", { name: /^design/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Permissions…" }).click();
  const dialog = page.getByRole("dialog", { name: "Permissions for design" });
  await dialog.getByLabel("Add a rule for a role").selectOption({ label: "Designer" });
  await dialog
    .getByRole("radiogroup", { name: "Write notes" })
    .getByRole("radio", { name: "Allow" })
    .click();
  await expect(
    dialog.getByRole("radiogroup", { name: "Write notes" }).getByRole("radio", { name: "Allow" }),
  ).toHaveAttribute("aria-checked", "true");
  // The preview agrees: Designer can write in design/ but not elsewhere.
  await dialog.getByLabel("A role", { exact: true }).selectOption({ label: "Designer" });
  await expect(
    dialog.getByRole("list", { name: "What they can do" }).locator("[data-allowed]"),
  ).toContainText(["Write notes"]);
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();

  // 4. The vault's member list shows Bo with the role's colour.
  await page.goto(`${base}/settings/vaults/notes`);
  const boRow = page.getByRole("listitem").filter({ hasText: "@bo" });
  await expect(boRow.locator(".role-chip")).toHaveText("Designer");
  await expect(boRow.locator(".role-chip")).toHaveCSS("border-top-color", "rgb(194, 90, 168)");

  // 5. Bo can edit design/ but nothing else.
  const context = await browser.newContext();
  const boPage = await context.newPage();
  await boPage.goto(`${base}/login`);
  await boPage.getByLabel("Username").fill("bo");
  await boPage.getByLabel("Password", { exact: true }).fill("another long password");
  await boPage.getByRole("button", { name: "Sign in" }).click();
  await expect(boPage).not.toHaveURL(/\/login/);
  await boPage.goto(`${base}/v/notes/other/b.md`);
  await expect(boPage.getByText("View only")).toBeVisible();
  await boPage.goto(`${base}/v/notes/design/a.md`);
  await expect(boPage.getByRole("article", { name: "a.md" })).toBeVisible();
  await expect(boPage.getByText("View only")).toHaveCount(0);

  // The server agrees with the screen.
  const status = (path: string) =>
    boPage.evaluate(async (p) => {
      const me = await (await fetch("/api/auth/me")).json();
      const res = await fetch(`/api/vaults/notes/files/${p}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Palimvo-Csrf": me.csrfToken },
        body: JSON.stringify({ content: "edited" }),
      });
      return res.status;
    }, path);
  expect(await status("design/a.md")).toBe(200);
  expect(await status("other/b.md")).toBe(403);
  await context.close();
});
