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

test("an AI proposes changes to two notes; a person accepts one and rejects the other", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const api = async (method: string, path: string, body?: unknown, author?: string) => {
    const res = await fetch(`${base}/api/vaults/notes${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(author ? { "X-Palimvo-Author": encodeURIComponent(author) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
  const plan = (await api("PUT", "/files/Plan.md", { content: "# Plan\n\nLaunch in June.\n" }))
    .body as { version: string };
  const team = (await api("PUT", "/files/Team.md", { content: "# Team\n\nLead: Dana\n" })).body as {
    version: string;
  };

  // The AI may only propose: nothing changes until a person decides.
  const proposed = await api(
    "POST",
    "/proposals",
    {
      title: "Move the launch",
      rationale: "The vendor is late.",
      files: [
        {
          path: "Plan.md",
          baseRevision: plan.version,
          hunks: [{ before: "June", after: "September", rationale: "New date" }],
        },
        {
          path: "Team.md",
          baseRevision: team.version,
          hunks: [{ before: "Dana", after: "Eli", rationale: "New lead" }],
        },
      ],
    },
    "ai:Claude Code",
  );
  expect(proposed.status).toBe(201);

  await page.goto(`${base}/v/notes/Plan.md`);
  await expect(page.getByRole("article", { name: "Plan.md" })).toBeVisible();
  await page.getByRole("button", { name: /^Proposals/ }).click();
  const card = page.getByRole("list", { name: "Proposed changes" }).getByRole("listitem");
  await expect(card).toContainText("Move the launch");
  await expect(card).toContainText("Claude Code");
  await card.getByRole("button", { name: "Review Move the launch" }).click();

  const dialog = page.getByRole("dialog", { name: "Move the launch" });
  await expect(dialog).toContainText("The vendor is late.");
  await expect(dialog.locator(".diff-del").first()).toContainText("Launch in June.");
  await expect(dialog.locator(".diff-add").first()).toContainText("Launch in September.");

  // Accept the date change, reject the new lead.
  await dialog.getByRole("checkbox", { name: "Change 1 in Plan.md" }).check();
  await dialog.getByRole("button", { name: "Accept selected (1)" }).click();
  await expect(dialog.getByText(/^Accepted/)).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Change 1 in Team.md" }).check();
  await dialog.getByRole("button", { name: "Reject selected (1)" }).click();
  await expect(dialog.getByText(/^Rejected/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();

  const read = async (file: string) =>
    ((await api("GET", `/files/${file}`)).body as { content: string }).content;
  expect(await read("Plan.md")).toContain("Launch in September.");
  expect(await read("Team.md")).toContain("Lead: Dana");

  // The history credits the AI that proposed it and says who accepted.
  await page.getByRole("button", { name: "Show details panel" }).click();
  const entries = page.getByRole("list", { name: "Changes to Plan.md" }).getByRole("listitem");
  await expect(entries.first()).toContainText("Claude Code");
  await expect(entries.first().locator(".author-kind")).toHaveText("AI");
  await expect(entries.first()).toContainText("Approved by Anonymous");
  await expect(entries.first()).toContainText("Move the launch");
});
