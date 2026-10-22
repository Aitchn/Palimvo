import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

/** A small fake server: one vault with a few files. */
export async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/vaults", (route) =>
    route.fulfill({ json: { vaults: [{ id: "sample", name: "sample" }] } }),
  );
  await page.route("**/api/vaults/sample/files", (route) =>
    route.fulfill({
      json: {
        tree: [
          {
            name: "Projects",
            path: "Projects",
            type: "folder",
            children: [
              { name: "Roadmap.md", path: "Projects/Roadmap.md", type: "file", kind: "markdown" },
              { name: "Board.canvas", path: "Projects/Board.canvas", type: "file", kind: "canvas" },
            ],
          },
          { name: "Tasks.base", path: "Tasks.base", type: "file", kind: "base" },
          { name: "Welcome.md", path: "Welcome.md", type: "file", kind: "markdown" },
        ],
      },
    }),
  );
  await page.route("**/api/vaults/sample/files/**", (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname).split("/files/")[1];
    return route.fulfill({
      json: { path, content: `# ${path}\n\nText of ${path}.`, mtime: 1, version: "v1" },
    });
  });
}

/** Where a screenshot goes: tests/e2e/screenshots/<name>.png (CI uploads the folder). */
export function shotPath(name: string): string {
  return fileURLToPath(new URL(`./screenshots/${name}.png`, import.meta.url));
}
