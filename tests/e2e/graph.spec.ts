import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { mockApi, shotPath } from "./mocks.ts";

// The official graph plugin in a real browser: the whole-vault page, the side panel around the
// open note, and a vault of 10,000 notes. The server is mocked; the graph comes from `graphFor`,
// which answers like `GET /api/vaults/:vault/graph`.

const folder = fileURLToPath(new URL("../../plugins/graph/", import.meta.url));

interface GNode {
  path: string;
  title: string;
  kind: "markdown" | "canvas" | "base";
  tags?: string[];
}
interface GEdge {
  from: string;
  to: string;
  embed: boolean;
}
interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  unresolved: never[];
}

const note = (path: string, tags?: string[]): GNode => ({
  path,
  title: path.replace(/^.*\//, "").replace(/\.\w+$/, ""),
  kind: "markdown",
  ...(tags ? { tags } : {}),
});

const small: Graph = {
  nodes: [
    note("Welcome.md", ["intro"]),
    note("Projects/Roadmap.md", ["intro", "plan"]),
    note("Projects/Ideas.md", ["plan"]),
    note("Projects/Archive.md"),
    { path: "Projects/Board.canvas", title: "Board", kind: "canvas" },
    note("Lonely.md"),
  ],
  edges: [
    { from: "Welcome.md", to: "Projects/Roadmap.md", embed: false },
    { from: "Projects/Roadmap.md", to: "Projects/Ideas.md", embed: false },
    { from: "Projects/Ideas.md", to: "Projects/Archive.md", embed: true },
    { from: "Projects/Board.canvas", to: "Welcome.md", embed: false },
  ],
  unresolved: [],
};

/** What the server answers for the options in the query string. */
function graphFor(graph: Graph, params: URLSearchParams): Graph {
  const withTags = params.get("tags") === "1";
  let nodes = graph.nodes.map((n) => {
    if (withTags) return n;
    const { tags: _tags, ...rest } = n;
    return rest;
  });
  let edges = graph.edges;
  const around = params.get("around");
  if (around) {
    const depth = Number(params.get("depth") ?? 1);
    const reached = new Set([around]);
    let frontier = [around];
    for (let step = 0; step < depth; step++) {
      const found: string[] = [];
      for (const e of edges) {
        for (const [a, b] of [
          [e.from, e.to],
          [e.to, e.from],
        ] as const) {
          if (frontier.includes(a) && !reached.has(b)) {
            reached.add(b);
            found.push(b);
          }
        }
      }
      frontier = found;
    }
    nodes = nodes.filter((n) => reached.has(n.path));
    edges = edges.filter((e) => reached.has(e.from) && reached.has(e.to));
  }
  return { nodes, edges, unresolved: [] };
}

function pluginFiles() {
  const read = (file: string) => readFileSync(`${folder}${file}`, "utf8");
  const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;
  const files: Record<string, string> = { "main.js": read("main.js") };
  for (const path of Object.values(manifest.locales as Record<string, string>))
    files[path] = read(path);
  return { manifest, files, hash: "g".repeat(64) };
}

async function serve(page: Page, graph: Graph) {
  await mockApi(page);
  const requests: string[] = [];
  const plugin = pluginFiles();
  await page.route("**/api/vaults/sample/plugin-runtime", (route) =>
    route.fulfill({
      json: {
        plugins: [
          {
            id: "graph",
            version: plugin.manifest.version,
            hash: plugin.hash,
            manifest: plugin.manifest,
          },
        ],
      },
    }),
  );
  await page.route("**/api/vaults/sample/plugin-runtime/graph", (route) =>
    route.fulfill({ json: { id: "graph", hash: plugin.hash, files: plugin.files } }),
  );
  await page.route("**/api/vaults/sample/graph**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    return route.fulfill({ json: graphFor(graph, url.searchParams) });
  });
  return requests;
}

/** The plugin's frame once it has drawn its first picture. */
async function drawnFrame(page: Page, selector: string): Promise<Frame> {
  const handle = await page.locator(selector).elementHandle();
  const frame = await handle!.contentFrame();
  await frame!.waitForSelector("body[data-ready]");
  return frame!;
}

/** Waits until the layout has stopped moving. */
async function settled(frame: Frame) {
  await frame.waitForFunction(
    () => (window as unknown as { __graph?: { settled: boolean } }).__graph?.settled === true,
    null,
    {
      timeout: 30_000,
    },
  );
}

/** Where a note's dot is on the page. */
async function dotOf(page: Page, frame: Frame, path: string, canvas = "canvas") {
  const at = await frame.evaluate(
    (p) =>
      (window as unknown as { __graph: { screenOf(p: string): number[] | null } }).__graph.screenOf(
        p,
      ),
    path,
  );
  expect(at, `dot of ${path}`).not.toBeNull();
  const box = (await frame.locator(canvas).boundingBox())!;
  return { x: box.x + at![0]!, y: box.y + at![1]! };
}

test.use({ viewport: { width: 1280, height: 800 }, locale: "en", colorScheme: "dark" });

test.describe("graph page", () => {
  test("draws the links, opens a note from its dot and finds notes by name", async ({ page }) => {
    const requests = await serve(page, small);
    await page.goto("/v/sample?plugin=graph&view=links");
    const frame = await drawnFrame(page, ".plugin-view iframe");
    await settled(frame);
    const ui = page.frameLocator(".plugin-view iframe");
    await expect(ui.getByRole("status").filter({ hasText: "notes" })).toHaveText(
      "Notes: 6 · Links: 4",
    );
    await expect(ui.getByRole("img")).toHaveAttribute("aria-label", /Link graph of 6 notes/);
    await page.screenshot({ path: shotPath("graph-page") });

    // Clicking a dot opens that note.
    const dot = await dotOf(page, frame, "Welcome.md");
    await page.mouse.click(dot.x, dot.y);
    await expect(page).toHaveURL(/\/v\/sample\/Welcome\.md$/);

    // The search box finds a note and Enter opens the best match.
    await page.goto("/v/sample?plugin=graph&view=links");
    const again = page.frameLocator(".plugin-view iframe");
    await again.getByRole("searchbox", { name: "Find a note" }).fill("road");
    await expect(again.getByRole("option", { name: /Roadmap/ })).toBeVisible();
    await again.getByRole("searchbox", { name: "Find a note" }).press("Enter");
    await expect(page).toHaveURL(/\/v\/sample\/Projects\/Roadmap\.md$/);
    expect(requests.every((q) => q === "")).toBe(true);
  });

  test("can hide embeds and unlinked notes, show tags and filter one folder", async ({ page }) => {
    const requests = await serve(page, small);
    await page.goto("/v/sample?plugin=graph&view=links");
    await drawnFrame(page, ".plugin-view iframe");
    const ui = page.frameLocator(".plugin-view iframe");
    const summary = ui.getByRole("status").filter({ hasText: "notes" });
    await expect(summary).toHaveText("Notes: 6 · Links: 4");

    await ui.getByLabel("Embeds").uncheck();
    await expect(summary).toHaveText("Notes: 6 · Links: 3");
    // The archive was only embedded, so it is now unlinked too.
    await ui.getByLabel("Unlinked notes").uncheck();
    await expect(summary).toHaveText("Notes: 4 · Links: 3");

    // The board and the folder's other notes link out of the folder, so only two stay linked.
    // Tags are only fetched when asked for, and each tag used twice becomes a node.
    expect(requests).toEqual([""]);
    await ui.getByLabel("Tags", { exact: true }).check();
    await expect(summary).toHaveText("Notes: 4 · Links: 3 · Tags: 2");
    expect(requests).toEqual(["", "?tags=1"]);

    await ui.getByRole("combobox", { name: "Folder" }).selectOption("Projects");
    await expect(summary).toHaveText("Notes: 2 · Links: 1 · Tags: 1");
  });

  test.describe("in Traditional Chinese", () => {
    test.use({ locale: "zh-TW" });

    test("speaks the language of the app", async ({ page }) => {
      await serve(page, small);
      await page.goto("/v/sample?plugin=graph&view=links");
      await drawnFrame(page, ".plugin-view iframe");
      const ui = page.frameLocator(".plugin-view iframe");
      await expect(ui.getByRole("searchbox", { name: "尋找筆記" })).toBeVisible();
      await expect(ui.getByText("6 則筆記、4 條連結")).toBeVisible();
    });
  });
});

test.describe("local graph", () => {
  test("shows the notes around the open note in the details panel", async ({ page }) => {
    const requests = await serve(page, small);
    await page.goto("/v/sample/Projects/Roadmap.md");
    await page.getByRole("button", { name: "Show details panel" }).click();
    const section = page.getByRole("region", { name: "Local graph" });
    await expect(section).toBeVisible();
    const frame = await drawnFrame(page, ".inspector iframe");
    await settled(frame);
    const ui = page.frameLocator(".inspector iframe");
    await expect(ui.getByRole("status").filter({ hasText: "notes" })).toHaveText(
      "Notes: 3 · Links: 2",
    );
    expect(requests).toContain("?around=Projects%2FRoadmap.md&depth=1");
    await page.screenshot({ path: shotPath("graph-local") });

    // More links away.
    await ui.getByRole("button", { name: "3" }).click();
    await expect(ui.getByRole("status").filter({ hasText: "notes" })).toHaveText(
      "Notes: 5 · Links: 4",
    );

    // A dot in the small picture opens that note, and the panel follows.
    const roadmapFrame = await drawnFrame(page, ".inspector iframe");
    await settled(roadmapFrame);
    const dot = await dotOf(page, roadmapFrame, "Welcome.md");
    await page.mouse.click(dot.x, dot.y);
    await expect(page).toHaveURL(/\/v\/sample\/Welcome\.md$/);
    await expect.poll(() => requests.some((q) => q.startsWith("?around=Welcome.md"))).toBe(true);
  });
});

/** A reproducible vault: `n` notes in 40 folders, `links` links, half of them to a few hubs. */
function bigVault(n: number, links: number): Graph {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const nodes = Array.from({ length: n }, (_, i) => note(`topic-${i % 40}/note-${i}.md`));
  nodes[0] = note("Welcome.md");
  const edges: GEdge[] = [];
  const seen = new Set<string>();
  while (edges.length < links) {
    const a = Math.floor(rand() * n);
    const b = rand() < 0.5 ? Math.floor(rand() * n * 0.05) : Math.floor(rand() * n);
    if (a === b || seen.has(`${a}-${b}`)) continue;
    seen.add(`${a}-${b}`);
    edges.push({ from: nodes[a]!.path, to: nodes[b]!.path, embed: false });
  }
  return { nodes, edges, unresolved: [] };
}

/** Frames per second the frame manages while `act` runs (page animation frames and drawn frames). */
async function measure(frame: Frame, act: () => Promise<void>) {
  await frame.evaluate(() => {
    const w = window as unknown as { __fps: { frames: number; start: number; stop: boolean } };
    w.__fps = { frames: 0, start: performance.now(), stop: false };
    const loop = () => {
      w.__fps.frames++;
      if (!w.__fps.stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const drawnBefore = await frame.evaluate(() =>
    Number(document.querySelector<HTMLElement>(".pg-stage")!.dataset.frames ?? 0),
  );
  await act();
  return frame.evaluate((before) => {
    const w = window as unknown as { __fps: { frames: number; start: number; stop: boolean } };
    w.__fps.stop = true;
    const seconds = (performance.now() - w.__fps.start) / 1000;
    const drawn = Number(document.querySelector<HTMLElement>(".pg-stage")!.dataset.frames ?? 0);
    return { fps: w.__fps.frames / seconds, drawnFps: (drawn - before) / seconds };
  }, drawnBefore);
}

test.describe("a vault of 10,000 notes", () => {
  test.setTimeout(120_000);

  test("opens in under 3 seconds and stays interactive", async ({ page }) => {
    const vault = bigVault(10_000, 25_000);
    await serve(page, vault);
    await page.goto("/v/sample");
    await page.waitForSelector(".plugin-views");
    const started = Date.now();
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    const frame = await drawnFrame(page, ".plugin-view iframe");
    const openMs = Date.now() - started;
    const ui = page.frameLocator(".plugin-view iframe");
    await expect(ui.getByRole("status").filter({ hasText: "notes" })).toHaveText(
      "Notes: 10000 · Links: 25000",
    );

    const box = (await frame.locator("canvas").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const results: Record<string, number> = { openMs };

    // While the layout is still moving, then after it has settled.
    const settling = await measure(frame, () => page.waitForTimeout(1500));
    results.settlingFps = Math.round(settling.fps);
    results.settlingDrawnFps = Math.round(settling.drawnFps);
    await settled(frame);
    await page.screenshot({ path: shotPath("graph-10k") });

    // The drawing alone: 120 frames of zooming in and out, driven from inside the frame.
    results.drawFps = Math.round(
      await frame.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const graph = (window as unknown as { __graph: { zoom(f: number): void } }).__graph;
            const start = performance.now();
            let frames = 0;
            const step = () => {
              graph.zoom(frames % 2 ? 1.02 : 0.98);
              if (++frames < 120) requestAnimationFrame(step);
              else resolve((frames / (performance.now() - start)) * 1000);
            };
            step();
          }),
      ),
    );
    await frame.evaluate(() => (window as unknown as { __graph: { fit(): void } }).__graph.fit());

    // Pan with the mouse.
    const pan = await measure(frame, async () => {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 0; i < 90; i++) {
        await page.mouse.move(cx + Math.sin(i / 8) * 160, cy + Math.cos(i / 8) * 90);
        await page.waitForTimeout(8);
      }
      await page.mouse.up();
    });
    results.panFps = Math.round(pan.fps);
    results.panDrawnFps = Math.round(pan.drawnFps);

    // Zoom with the wheel.
    const zoom = await measure(frame, async () => {
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, i < 20 ? -80 : 80);
        await page.waitForTimeout(16);
      }
    });
    results.zoomFps = Math.round(zoom.fps);
    results.zoomDrawnFps = Math.round(zoom.drawnFps);

    // Drag a note around.
    await frame.evaluate(() => (window as unknown as { __graph: { fit(): void } }).__graph.fit());
    await page.waitForTimeout(200);
    const hub = await dotOf(page, frame, vault.nodes[1]!.path);
    const drag = await measure(frame, async () => {
      await page.mouse.move(hub.x, hub.y);
      await page.mouse.down();
      for (let i = 0; i < 90; i++) {
        await page.mouse.move(hub.x + Math.sin(i / 6) * 60, hub.y + Math.cos(i / 6) * 40);
        await page.waitForTimeout(8);
      }
      await page.mouse.up();
    });
    results.dragFps = Math.round(drag.fps);
    results.dragDrawnFps = Math.round(drag.drawnFps);

    console.log(`graph 10k: ${JSON.stringify(results)}`);
    mkdirSync(fileURLToPath(new URL("./results/", import.meta.url)), { recursive: true });
    writeFileSync(
      fileURLToPath(new URL("./results/graph-10k.json", import.meta.url)),
      JSON.stringify(results, null, 2),
    );
    test.info().annotations.push({ type: "graph-10k", description: JSON.stringify(results) });

    expect(openMs).toBeLessThan(3000);
    // Software rendering in CI is slower than a laptop; these floors still mean "not a slideshow".
    expect(results.panFps).toBeGreaterThanOrEqual(15);
    expect(results.zoomFps).toBeGreaterThanOrEqual(15);
    expect(results.dragFps).toBeGreaterThanOrEqual(10);
  });
});
