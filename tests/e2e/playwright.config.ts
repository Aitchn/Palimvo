import { defineConfig } from "@playwright/test";

// Run `pnpm build` first; the tests serve the built web app with `vite preview`.
export default defineConfig({
  testDir: ".",
  outputDir: "./results",
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "./report" }]]
    : "list",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:4173",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: "pnpm --filter @palimvo/web exec vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
