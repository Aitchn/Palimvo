#!/usr/bin/env node
// Lists missing, extra, untranslated and review-flagged keys per locale.
// Fails (exit 1) on missing keys, extra keys or placeholder mismatches;
// untranslated and review-flagged keys are informational.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LOCALES, compareLocale } from "../packages/i18n/src/index.ts";

const dir = new URL("../packages/i18n/locales/", import.meta.url);
const load = (locale) => JSON.parse(readFileSync(new URL(`${locale}.json`, dir), "utf8"));
const reference = load("en");

let failed = false;
for (const locale of SUPPORTED_LOCALES) {
  if (locale === "en") continue;
  const report = compareLocale(reference, load(locale));
  const hard = [
    ["missing", report.missing],
    ["extra", report.extra],
    ["placeholder mismatch", report.placeholderMismatch],
  ];
  const soft = [
    ["flagged for review", report.review],
    ["identical to English", report.untranslated],
  ];
  console.log(`\n${locale}`);
  for (const [label, keys] of [...hard, ...soft]) {
    if (keys.length) console.log(`  ${label}: ${keys.join(", ")}`);
  }
  if (hard.some(([, keys]) => keys.length)) failed = true;
  else console.log("  ok");
}
if (failed) {
  console.error(`\ni18n check failed (${fileURLToPath(dir)})`);
  process.exit(1);
}
