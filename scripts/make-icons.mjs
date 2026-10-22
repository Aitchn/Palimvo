#!/usr/bin/env node
// Renders the PNG icons the web manifest and iOS need from apps/web/public/icons/palimvo.svg.
// Usage: pnpm icons   (needs a Chromium; set PLAYWRIGHT_CHROMIUM_PATH to use a specific one)
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const dir = new URL("../apps/web/public/icons/", import.meta.url);
const svg = readFileSync(new URL("palimvo.svg", dir), "utf8");
const full = svg.replace(' rx="112"', "");
const maskable = full.replace(
  /<path /,
  '<path transform="translate(256 256) scale(0.8) translate(-256 -256)" ',
);

const jobs = [
  ["icon-192.png", svg, 192, true],
  ["icon-512.png", svg, 512, true],
  ["maskable-512.png", maskable, 512, false],
  ["apple-touch-icon.png", full, 180, false],
];

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });
const page = await browser.newPage();
for (const [name, source, size, transparent] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  );
  const png = await page.screenshot({ omitBackground: transparent });
  writeFileSync(new URL(name, dir), png);
  console.log(`${name} ${png.length} bytes`);
}
await browser.close();
