import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        URL: "readonly",
        console: "readonly",
        process: "readonly",
        performance: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    files: ["apps/web/sw-template.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Response: "readonly",
      },
    },
  },
  {
    // Example plugins run in the sandbox iframe: browser ES modules.
    files: ["plugins/examples/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { document: "readonly" },
    },
  },
  {
    // The graph plugin draws on a canvas in its sandbox frame (and its pure parts run in tests).
    files: ["plugins/graph/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        document: "readonly",
        window: "readonly",
        performance: "readonly",
        getComputedStyle: "readonly",
        matchMedia: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        ResizeObserver: "readonly",
        Path2D: "readonly",
      },
    },
  },
  {
    // Runs inside the plugin sandbox iframe, as a raw string; it is a browser script.
    files: ["apps/web/src/plugins/runtime.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        parent: "readonly",
        crypto: "readonly",
        console: "readonly",
        URL: "readonly",
        Blob: "readonly",
        ResizeObserver: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    // Official plugins: ES modules that run in the plugin sandbox iframe (a browser).
    files: ["plugins/*/main.js", "plugins/examples/*/main.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        document: "readonly",
        console: "readonly",
        Intl: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Event: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // S1 rule 6: the wrapper in store/db.ts is the only place that may touch node:sqlite.
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs"],
    ignores: ["apps/server/src/store/db.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:sqlite",
              message: "Use the Db wrapper in apps/server/src/store/db.ts instead.",
            },
            {
              name: "sqlite",
              message: "Use the Db wrapper in apps/server/src/store/db.ts instead.",
            },
          ],
        },
      ],
    },
  },
);
