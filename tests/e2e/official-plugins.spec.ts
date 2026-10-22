import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, shotPath } from "./mocks.ts";

// The official plugins (plugins/*) as shipped: their real files run in the real sandbox, against
// a small in-memory vault. The server is mocked.

const pluginsDir = fileURLToPath(new URL("../../plugins/", import.meta.url));

function official(id: string) {
  const root = `${pluginsDir}${id}/`;
  const manifest = JSON.parse(readFileSync(`${root}manifest.json`, "utf8")) as Record<
    string,
    unknown
  >;
  const files: Record<string, string> = {};
  const add = (path: string) => (files[path] = readFileSync(`${root}${path}`, "utf8"));
  add(manifest.main as string);
  const locales = (manifest.locales ?? {}) as Record<string, string>;
  for (const path of Object.values(locales)) add(path);
  return { manifest, files, hash: id.length.toString(16).repeat(64).slice(0, 64) };
}

/** Serves the given official plugins and a vault of `notes` (path → text) that PUT changes. */
async function serve(page: Page, ids: string[], notes: Record<string, string>) {
  await mockApi(page);
  const plugins = ids.map(official);
  const puts: Array<[string, string]> = [];
  await page.route("**/api/vaults/sample/plugin-runtime", (route) =>
    route.fulfill({
      json: {
        plugins: plugins.map((p) => ({
          id: p.manifest.id,
          version: p.manifest.version,
          hash: p.hash,
          manifest: p.manifest,
        })),
      },
    }),
  );
  await page.route("**/api/vaults/sample/plugin-runtime/*", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    const found = plugins.find((p) => p.manifest.id === id)!;
    return route.fulfill({ json: { id, hash: found.hash, files: found.files } });
  });
  const tree = () => {
    const root: Array<Record<string, unknown>> = [];
    for (const path of Object.keys(notes).sort()) {
      const parts = path.split("/");
      let level = root;
      parts.forEach((name, i) => {
        const full = parts.slice(0, i + 1).join("/");
        if (i === parts.length - 1) {
          level.push({
            name,
            path: full,
            type: "file",
            kind: name.endsWith(".md") ? "markdown" : "other",
          });
          return;
        }
        let folder = level.find((n) => n.path === full);
        if (!folder) {
          folder = { name, path: full, type: "folder", children: [] };
          level.push(folder);
        }
        level = folder.children as Array<Record<string, unknown>>;
      });
    }
    return root;
  };
  await page.route("**/api/vaults/sample/files", (route) =>
    route.fulfill({ json: { tree: tree() } }),
  );
  await page.route("**/api/vaults/sample/files/**", async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname).split("/files/")[1]!;
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { content: string };
      notes[path] = body.content;
      puts.push([path, body.content]);
      return route.fulfill({ json: { version: `v${puts.length}` } });
    }
    if (!(path in notes))
      return route.fulfill({ status: 404, json: { code: "not_found", message: "no" } });
    return route.fulfill({ json: { path, content: notes[path], mtime: 1, version: "v0" } });
  });
  return { puts, notes };
}

const frameOf = (page: Page, id: string) =>
  page.frameLocator(`.plugin-host[data-plugin="${id}"] iframe`);

const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
const TASKS = {
  "tasks/Write docs.md": "---\nstatus: todo\ndue: 2020-01-01\n---\n# Write docs\n",
  "tasks/Ship it.md": "---\nstatus: doing\n---\n# Ship it\n",
  "tasks/Celebrate.md": `---\nstatus: done\ndue: ${inTenDays}\n---\n# Celebrate\n`,
  "Welcome.md": "# Welcome\n",
};

test.describe("official plugins ship what their manifests promise", () => {
  test("every folder under plugins/ with a main file has all the files its manifest names", () => {
    for (const id of readdirSync(pluginsDir).filter((n) => !n.includes("."))) {
      const manifest = JSON.parse(readFileSync(`${pluginsDir}${id}/manifest.json`, "utf8")) as {
        main?: string;
        locales?: Record<string, string>;
      };
      if (id === "decisions") continue; // lands with T36
      for (const path of [manifest.main, ...Object.values(manifest.locales ?? {})]) {
        expect(() => readFileSync(`${pluginsDir}${id}/${path}`), `${id}/${path}`).not.toThrow();
      }
    }
  });
});

test.describe("kanban and kanban-due", () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: "en", reducedMotion: "reduce" });

  test("the board groups notes by status, shows due badges and moves a card", async ({ page }) => {
    const vault = await serve(page, ["kanban", "kanban-due"], { ...TASKS });
    await page.goto("/v/sample");
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const board = frameOf(page, "kanban");
    await expect(board.locator(".kb-col")).toHaveCount(3);
    await expect(
      board.locator('[data-column="todo"] [data-path="tasks/Write docs.md"]'),
    ).toBeVisible();
    await expect(
      board.locator('[data-column="doing"] [data-path="tasks/Ship it.md"]'),
    ).toBeVisible();
    // Notes without the property (Welcome.md) are not cards.
    await expect(board.locator(".kb-card")).toHaveCount(3);

    // kanban-due answers through the extension point, in its own sandbox.
    const overdue = board.locator('[data-path="tasks/Write docs.md"] .kb-badge.tone-danger');
    await expect(overdue).toContainText("Overdue by");
    await expect(
      board.locator('[data-path="tasks/Celebrate.md"] .kb-badge.tone-muted'),
    ).toContainText("Due in");
    await expect(board.locator('[data-path="tasks/Ship it.md"] .kb-badge')).toHaveCount(0);
    await page.screenshot({ path: shotPath("official-kanban-desktop") });

    // Drag a card to another column.
    await board
      .locator('[data-path="tasks/Ship it.md"]')
      .dragTo(board.locator('[data-column="done"]'));
    await expect(
      board.locator('[data-column="done"] [data-path="tasks/Ship it.md"]'),
    ).toBeVisible();
    expect(vault.notes["tasks/Ship it.md"]).toBe("---\nstatus: done\n---\n# Ship it\n");

    // The same move from the card's menu (touch and keyboard users).
    await board.locator('[data-path="tasks/Write docs.md"] select').selectOption("doing");
    await expect(
      board.locator('[data-column="doing"] [data-path="tasks/Write docs.md"]'),
    ).toBeVisible();
    expect(vault.notes["tasks/Write docs.md"]).toContain("status: doing");
    expect(vault.notes["tasks/Write docs.md"]).toContain("due: 2020-01-01");
    expect(vault.puts).toHaveLength(2);
  });

  test("a card is created in the first column and the board works without kanban-due", async ({
    page,
  }) => {
    const vault = await serve(page, ["kanban"], { ...TASKS });
    await page.goto("/v/sample");
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const board = frameOf(page, "kanban");
    await board.getByLabel("Folder").fill("tasks");
    await board.getByLabel("Folder").press("Enter");
    await board.getByRole("textbox", { name: /New card/ }).fill("Plan trip");
    await board.getByRole("textbox", { name: /New card/ }).press("Enter");
    await expect(
      board.locator('[data-column="todo"] [data-path="tasks/Plan trip.md"]'),
    ).toBeVisible();
    expect(vault.notes["tasks/Plan trip.md"]).toBe("---\nstatus: todo\n---\n# Plan trip\n");
    await expect(board.locator(".kb-badge")).toHaveCount(0);
  });
});

test.describe("kanban on a phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    locale: "zh-TW",
    hasTouch: true,
    reducedMotion: "reduce",
  });

  test("columns scroll sideways, labels are in the interface language, the menu moves a card", async ({
    page,
  }) => {
    const vault = await serve(page, ["kanban", "kanban-due"], { ...TASKS });
    await page.goto("/v/sample");
    await page.getByRole("button", { name: "開啟選單" }).click();
    await page.getByRole("button", { name: "看板", exact: true }).tap();
    const board = frameOf(page, "kanban");
    await expect(board.locator('[data-column="todo"] h3')).toContainText("待辦");
    await expect(board.locator('[data-path="tasks/Write docs.md"] .kb-badge')).toContainText(
      "已逾期",
    );
    await board.locator('[data-path="tasks/Write docs.md"] select').selectOption("done");
    await expect(
      board.locator('[data-column="done"] [data-path="tasks/Write docs.md"]'),
    ).toBeVisible();
    expect(vault.notes["tasks/Write docs.md"]).toContain("status: done");
    await page.screenshot({ path: shotPath("official-kanban-mobile") });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("json-tree", () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: "en", reducedMotion: "reduce" });

  test("a .json file opens as a tree with search, and the text is one click away", async ({
    page,
  }) => {
    await serve(page, ["json-tree"], {
      "data/config.json": JSON.stringify({
        name: "palimvo",
        server: { port: 3000, tls: false },
        tags: ["a", "b"],
      }),
    });
    await page.goto("/v/sample/data/config.json");
    const tree = frameOf(page, "json-tree");
    await expect(tree.getByText('"palimvo"')).toBeVisible();
    await expect(tree.locator("summary", { hasText: "server:" })).toBeVisible();
    await tree.getByRole("textbox", { name: "Search keys or values" }).fill("tls");
    await expect(tree.getByText("tls:")).toBeVisible();
    await expect(tree.getByText("tags:")).toHaveCount(0);
    await page.screenshot({ path: shotPath("official-json-tree") });
    await page.getByRole("button", { name: "Text" }).click();
    await expect(page.getByRole("article", { name: "config.json" }).last()).toContainText(
      "palimvo",
    );
  });
});

test.describe("chart-pack", () => {
  test.use({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" });

  // The host does not draw `component` blocks yet (T21/T23 attach them), so the plugin's real
  // main.js is run in the browser against a small stand-in for the runtime's `palimvo` object.
  test("radar, treemap and sparkline draw real SVG in both themes", async ({ page }) => {
    await page.goto("about:blank");
    const code = readFileSync(`${pluginsDir}chart-pack/main.js`, "utf8");
    for (const theme of ["dark", "light"] as const) {
      await page.setContent(
        `<html data-theme="${theme}"><body style="margin:16px;background:${theme === "dark" ? "#0f1014" : "#fff"};color:${theme === "dark" ? "#e7e7ec" : "#111"};--bg:${theme === "dark" ? "#0f1014" : "#fff"};--fg:${theme === "dark" ? "#e7e7ec" : "#111"};--fg-muted:#8a8b97;--border:#8a8b9744;font-family:system-ui,sans-serif"><div id="a"></div><div id="b"></div><div id="c"></div></body></html>`,
      );
      const result = await page.evaluate(async (source) => {
        const handlers = new Map<string, (ctx: unknown) => unknown>();
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const mod = await import(/* @vite-ignore */ url);
        mod.default({
          i18n: { locale: "en", t: (k: string) => k },
          ui: {
            registerComponent: (t: string, fn: (ctx: unknown) => unknown) => handlers.set(t, fn),
          },
        });
        const run = (type: string, id: string, config: unknown) =>
          handlers.get(type)!({
            el: document.getElementById(id),
            type,
            config,
            data: null,
            locale: "en",
            theme: "dark",
          });
        await run("radar", "a", {
          title: "Options",
          axes: ["Speed", "Cost", "Safety", "Fit", "Look"],
          series: [
            { name: "Plan A", values: [4, 2, 5, 3, 4] },
            { name: "Plan B", values: [3, 4, 3, 5, 2] },
          ],
          max: 5,
        });
        await run("treemap", "b", {
          title: "Spending",
          items: [
            {
              name: "Home",
              children: [
                { name: "Rent", value: 900 },
                { name: "Power", value: 120 },
              ],
            },
            { name: "Food", value: 400 },
            { name: "Travel", value: 260 },
            { name: "Fun", value: 90 },
          ],
        });
        await run("sparkline", "c", {
          label: "Visits",
          unit: "/day",
          values: [3, 5, 4, 8, 6, 9, 12],
        });
        const box = (id: string) => document.querySelector(`#${id} svg`)!.getBoundingClientRect();
        return {
          polygons: document.querySelectorAll("#a svg polygon[fill-opacity]").length,
          cells: document.querySelectorAll("#b svg rect").length,
          line: document.querySelector("#c polyline")!.getAttribute("points"),
          last: document.querySelector("#c b")!.textContent,
          sizes: ["a", "b", "c"].map((id) => [box(id).width, box(id).height]),
          nan: document.body.innerHTML.includes("NaN"),
        };
      }, code);
      expect(result.polygons).toBe(2);
      expect(result.cells).toBe(5);
      expect(result.last).toBe("12/day");
      expect(result.nan).toBe(false);
      for (const [w, h] of result.sizes) {
        expect(w).toBeGreaterThan(50);
        expect(h).toBeGreaterThan(20);
      }
      await page.screenshot({ path: shotPath(`official-chart-pack-${theme}`) });
    }
  });
});
