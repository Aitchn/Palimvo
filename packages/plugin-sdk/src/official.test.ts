import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  it("ships the three planned plugins", () => {
    expect(folders.sort()).toEqual(["decisions", "kanban", "kanban-due"]);
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

  it("keeps the decisions plugin to its own folders and its server entry", () => {
    const json: unknown = JSON.parse(readFileSync(`${root}decisions/manifest.json`, "utf8"));
    const r = validateManifest(json, { palimvoVersion: "0.1.0" });
    expect(r.ok && r.manifest.permissions).toMatchObject({
      read: ["**/decisions/**"],
      write: ["**/decisions/**"],
    });
    expect(r.ok && r.manifest.server).toBe("server.js");
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
    expect(examples.sort()).toEqual([
      "chart-pack",
      "hello-app",
      "json-tree",
      "slots-demo",
      "theme-midnight",
    ]);
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

describe("official plugin files", () => {
  const withCode = [
    ...folders.map((f) => f),
    ...["chart-pack", "json-tree"].map((f) => `examples/${f}`),
  ].filter((f) => existsSync(`${root}${f}/main.js`));

  it("ships code for every official plugin", () => {
    expect(withCode.sort()).toEqual([
      "decisions",
      "examples/chart-pack",
      "examples/json-tree",
      "kanban",
      "kanban-due",
    ]);
  });

  it.each(withCode)(
    "%s has every file its manifest names and the same keys in each locale",
    (folder) => {
      const manifest = JSON.parse(readFileSync(`${root}${folder}/manifest.json`, "utf8")) as {
        locales: Record<string, string>;
      };
      const keys = Object.entries(manifest.locales).map(([locale, file]) => {
        expect(existsSync(`${root}${folder}/${file}`), `${folder}/${file}`).toBe(true);
        const strings = JSON.parse(readFileSync(`${root}${folder}/${file}`, "utf8")) as Record<
          string,
          string
        >;
        return [locale, Object.keys(strings).sort()] as const;
      });
      expect(keys.map(([locale]) => locale).sort()).toEqual(["en", "zh-CN", "zh-TW"]);
      for (const [locale, k] of keys) expect(k, `${folder} ${locale}`).toEqual(keys[0]![1]);
      expect(existsSync(`${root}${folder}/README.md`)).toBe(true);
    },
  );

  it("kanban-due contributes to a point kanban declares", () => {
    const read = (f: string) =>
      JSON.parse(readFileSync(`${root}${f}/manifest.json`, "utf8")) as {
        contributes: {
          extensionPoints?: Array<{ id: string }>;
          extensions?: Array<{ plugin: string; point: string }>;
        };
      };
    const points = read("kanban").contributes.extensionPoints?.map((p) => p.id);
    expect(read("kanban-due").contributes.extensions).toEqual([
      { plugin: "kanban", point: "card-badge" },
    ]);
    expect(points).toContain("card-badge");
  });
});
