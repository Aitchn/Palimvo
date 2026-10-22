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
      // No account yet: the API stays open and takes the author from a header.
      "--dev-insecure",
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

test("a new vault opens on its home page; AI changes and waiting proposals show up there", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ai = (name: string, reason: string) => ({
    "X-Palimvo-Author": encodeURIComponent(`ai:${name}`),
    "X-Palimvo-Reason": encodeURIComponent(reason),
  });

  expect((await send("POST", "/api/vaults", { id: "notes" })).status).toBe(201);

  // A brand-new vault shows the activity wall with no setup.
  await page.goto(`${base}/v/notes`);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const wall = page.getByRole("region", { name: "Recent activity" });
  await expect(wall).toBeVisible();
  await expect(page.getByRole("region", { name: "Waiting for review" })).toBeVisible();

  // An AI writes a note and another proposes a change; a person writes too.
  expect(
    (
      await send(
        "PUT",
        "/api/vaults/notes/files/Plan.md",
        { content: "# Plan\n\nLaunch in June.\n" },
        ai("Claude Code", "Drafted the plan"),
      )
    ).status,
  ).toBe(200);
  expect((await send("GET", "/api/vaults/notes/history")).status).toBe(200); // commits what waits
  const plan = (await (await send("GET", "/api/vaults/notes/files/Plan.md")).json()) as {
    version: string;
  };
  expect(
    (
      await send(
        "POST",
        "/api/vaults/notes/proposals",
        {
          title: "Move the launch",
          rationale: "The date slipped",
          files: [
            {
              path: "Plan.md",
              baseRevision: plan.version,
              hunks: [{ before: "June", after: "September", rationale: "Slipped" }],
            },
          ],
        },
        ai("Gemini", "Date slipped"),
      )
    ).status,
  ).toBe(201);

  await page.reload();
  const claude = wall.getByRole("list", { name: "Changes by Claude Code" });
  await expect(claude).toContainText("Drafted the plan");
  await expect(wall.locator(".activity-group[data-author-kind='ai']").first()).toBeVisible();
  await expect(wall.locator(".activity-group .author-kind").first()).toHaveText("AI");
  const waiting = page.getByRole("region", { name: "Waiting for review" });
  await expect(waiting).toContainText("Move the launch");
  await expect(waiting).toContainText("Gemini");

  // Only people: the AI's group goes away.
  await wall.getByRole("button", { name: /^People/ }).click();
  await expect(claude).toHaveCount(0);
  await wall.getByRole("button", { name: /^Everyone/ }).click();
  await expect(claude).toBeVisible();

  // Pin a note from the customize dialog; it stays after a reload.
  await page.getByRole("button", { name: "Customize" }).click();
  const dialog = page.getByRole("dialog", { name: "Customize" });
  await dialog.getByLabel("Choose a note").selectOption("Plan.md");
  await dialog.getByRole("button", { name: "Pin", exact: true }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  const pinned = page.getByRole("region", { name: "Pinned notes" });
  await expect(pinned.getByRole("button", { name: /Plan/ })).toBeVisible();
  await page.reload();
  await pinned.getByRole("button", { name: /Plan/ }).click();
  await expect(page.getByRole("article", { name: "Plan.md" })).toBeVisible();

  // The home button leads back, also from a file.
  await page.getByRole("button", { name: "Vault home" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
});
