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
      globals: { URL: "readonly", console: "readonly", process: "readonly" },
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
