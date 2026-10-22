import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Uploads and viewers against the real built server (`pnpm build` first), not a mock.
const SERVER = fileURLToPath(new URL("../../apps/server/dist/palimvo.mjs", import.meta.url));
const WEB = fileURLToPath(new URL("../../apps/web/dist", import.meta.url));
const MiB = 1024 * 1024;

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
  dataDir = await mkdtemp(path.join(tmpdir(), "palimvo-e2e-uploads-"));
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

test("upload a 100 MiB video and small files, then view them", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Set the server up through the wizard.
  await page.goto(base);
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Display name").fill("Ada");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Password again").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Vault name").fill("media");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/v\/media/);

  // Small files of every viewable kind go in through the picker.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  const input = page.getByTestId("import-input");
  await input.setInputFiles([
    { name: "dot.png", mimeType: "image/png", buffer: png },
    {
      name: "data.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"name":"Palimvo","tags":["a","b"]}'),
    },
    { name: "table.csv", mimeType: "text/csv", buffer: Buffer.from("item,qty\nApple,3\nPear,5\n") },
    { name: "doc.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") },
  ]);
  await expect(page.getByRole("treeitem", { name: /^dot\.png/ })).toBeVisible();

  await page.getByRole("treeitem", { name: /^dot\.png/ }).click();
  const img = page.getByRole("img", { name: "dot.png" });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);

  await page.getByRole("treeitem", { name: /^data\.json/ }).click();
  await expect(page.getByRole("tree", { name: "JSON" })).toContainText("Palimvo");

  await page.getByRole("treeitem", { name: /^table\.csv/ }).click();
  await expect(page.getByRole("columnheader", { name: "qty" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Pear" })).toBeVisible();

  await page.getByRole("treeitem", { name: /^doc\.pdf/ }).click();
  await expect(page.locator('iframe[title="doc.pdf"]')).toHaveAttribute("src", /\/raw\/doc\.pdf$/);

  // A 100 MiB video does not fit in one request: it goes up in parts, with a progress bar.
  // (Playwright refuses buffers over 50 MB, so the video is written to a file first.)
  const video = Buffer.alloc(100 * MiB);
  for (let i = 0; i < video.length; i += 4099) video[i] = i & 0xff;
  const videoFile = path.join(dataDir, "big.mp4");
  await writeFile(videoFile, video);
  await input.setInputFiles(videoFile);
  await expect(page.getByRole("treeitem", { name: /^big\.mp4/ })).toBeVisible({ timeout: 120_000 });
  expect((await stat(path.join(dataDir, "vaults", "media", "big.mp4"))).size).toBe(100 * MiB);

  // The file comes back byte for byte, and the viewer offers it as a video and as a download.
  const bytes = await page.evaluate(async () => {
    const res = await fetch("/api/vaults/media/raw/big.mp4", {
      headers: { Range: "bytes=4099-4103" },
    });
    return { status: res.status, body: Array.from(new Uint8Array(await res.arrayBuffer())) };
  });
  expect(bytes.status).toBe(206);
  expect(bytes.body[0]).toBe(4099 & 0xff);
  await page.getByRole("treeitem", { name: /^big\.mp4/ }).click();
  await expect(page.locator("video")).toHaveAttribute("src", /\/raw\/big\.mp4$/);
  await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    /\/raw\/big\.mp4\?download=1$/,
  );
});
