import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { referencedFiles } from "./manifest.ts";
import { validateManifest } from "./validate.ts";

const root = fileURLToPath(new URL("../../../plugins/", import.meta.url));
const folders = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "examples")
  .map((e) => e.name);
const examples = readdirSync(`${root}examples/`, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

describe("official plugin manifests", () => {
  it("ships the five planned plugins", () => {
    expect(folders.sort()).toEqual([
      "chart-pack",
      "decisions",
      "json-tree",
      "kanban",
      "kanban-due",
    ]);
  });

  it.each(folders)("%s passes validation and is named after its folder", (folder) => {
    const json: unknown = JSON.parse(readFileSync(`${root}${folder}/manifest.json`, "utf8"));
    const r = validateManifest(json, { palimvoVersion: "0.1.0" });
    expect(r.ok, r.ok ? "" : JSON.stringify(r.issues, null, 2)).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe(folder);
    const name = r.manifest.name;
    expect(typeof name === "object" && name["zh-TW"] && name["zh-CN"]).toBeTruthy();
  });

  it("declares the four decision tools", () => {
    const json: unknown = JSON.parse(readFileSync(`${root}decisions/manifest.json`, "utf8"));
    const r = validateManifest(json);
    expect(r.ok && r.manifest.contributes.tools.map((t) => t.name)).toEqual([
      "record_decision",
      "list_decisions",
      "update_decision_status",
      "list_decision_trees",
    ]);
  });

  it("keeps one example per UI layer in plugins/examples", () => {
    expect(examples.sort()).toEqual(["hello-app", "slots-demo", "theme-midnight"]);
  });

  it.each(examples)("example %s passes validation and ships the files it names", (folder) => {
    const json: unknown = JSON.parse(
      readFileSync(`${root}examples/${folder}/manifest.json`, "utf8"),
    );
    const r = validateManifest(json, { palimvoVersion: "0.1.0" });
    expect(r.ok, r.ok ? "" : JSON.stringify(r.issues, null, 2)).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe(folder);
    for (const file of referencedFiles(r.manifest)) {
      expect(() => readFileSync(`${root}examples/${folder}/${file}`, "utf8"), file).not.toThrow();
    }
  });
});
