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

test("an AI's change shows its name and reason; any version can be compared and restored", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // An AI client writes over REST, naming itself and why in headers.
  const ai = async (content: string, reason: string) => {
    const res = await fetch(`${base}/api/vaults/notes/files/Plan.md`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Palimvo-Author": encodeURIComponent("ai:Claude Code"),
        "X-Palimvo-Reason": encodeURIComponent(reason),
      },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(200);
  };
  expect(
    (
      await fetch(`${base}/api/vaults`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "notes" }),
      })
    ).status,
  ).toBe(201);
  await ai("# Plan\n\nLaunch in June.\n", "Drafted the plan");
  // Listing the history commits what is waiting, so the two writes are two versions.
  expect((await fetch(`${base}/api/vaults/notes/history`)).status).toBe(200);
  await ai("# Plan\n\nLaunch in September.\n", "Moved the launch date");

  await page.goto(`${base}/v/notes/Plan.md`);
  await expect(page.getByRole("article", { name: "Plan.md" })).toBeVisible();
  await page.getByRole("button", { name: "Show details panel" }).click();
  const list = page.getByRole("list", { name: "Changes to Plan.md" });
  const entries = list.getByRole("listitem");
  await expect(entries).toHaveCount(2);
  // Newest first: the AI's name, an AI tag, and the reason it gave.
  await expect(entries.first()).toContainText("Claude Code");
  await expect(entries.first().locator(".author-kind")).toHaveText("AI");
  await expect(entries.first()).toContainText("Moved the launch date");
  await expect(entries.last()).toContainText("Drafted the plan");

  // What the newest change did.
  await entries.first().getByRole("button", { name: "Changes" }).click();
  const diff = page.getByRole("dialog", { name: "Changes to Plan.md" });
  await expect(diff.locator(".diff-del")).toContainText("Launch in June.");
  await expect(diff.locator(".diff-add")).toContainText("Launch in September.");
  await diff.getByRole("button", { name: "Close", exact: true }).last().click();

  // Put the first version back; the restore is itself a new entry, made by this person.
  await entries.last().getByRole("button", { name: "Restore" }).click();
  await page
    .getByRole("dialog", { name: "Restore Plan.md?" })
    .getByRole("button", { name: "Restore this version" })
    .click();
  await expect(page.getByText("Version restored.")).toBeVisible();
  await expect(entries).toHaveCount(3);
  await expect(entries.first()).toContainText("Anonymous");
  await expect(entries.first().locator(".author-kind")).toHaveCount(0);
  const restored = await page.evaluate(async () => {
    const res = await fetch("/api/vaults/notes/files/Plan.md");
    return ((await res.json()) as { content: string }).content;
  });
  expect(restored).toContain("Launch in June.");

  // The vault's change log lists it too, and a checkpoint can be saved.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByRole("list", { name: "Changes in this vault" })).toContainText(
    "Moved the launch date",
  );
  await page.getByRole("button", { name: "Save a checkpoint" }).click();
  const dialog = page.getByRole("dialog", { name: "Save a checkpoint" });
  await dialog.getByLabel("What is this checkpoint?").fill("Before launch");
  await dialog.getByLabel("Short name (optional)").fill("before-launch");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("region", { name: "Checkpoints" })).toContainText("before-launch");
});
