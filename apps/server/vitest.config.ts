import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // File-system heavy tests on shared Windows CI runners can be several times slower than locally.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
