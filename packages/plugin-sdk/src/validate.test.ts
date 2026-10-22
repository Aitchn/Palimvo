import { describe, expect, it } from "vitest";
import { MANIFEST_LIMITS, referencedFiles, resolveLocalized } from "./manifest.ts";
import { parseManifest, validateManifest, type ManifestIssue } from "./validate.ts";

const base = { manifestVersion: 2, id: "demo", version: "1.0.0", name: "Demo" };

function issues(input: unknown): ManifestIssue[] {
  const r = validateManifest(input);
  if (r.ok) throw new Error("expected the manifest to be refused");
  return r.issues;
}

function codes(input: unknown): string[] {
  return issues(input).map((i) => `${i.path}:${i.code}`);
}

describe("validateManifest", () => {
  it("accepts a minimal manifest and fills in defaults", () => {
    const r = validateManifest(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.permissions).toEqual({ read: [], write: [], network: false });
    expect(r.manifest.dependencies).toEqual({});
    expect(r.manifest.main).toBe("main.js");
    expect(r.manifest.contributes.tools).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("accepts a full manifest", () => {
    const r = validateManifest({
      ...base,
      name: { en: "Demo", "zh-TW": "示範" },
      description: "Does things",
      author: "Someone",
      license: "MIT",
      homepage: "https://example.com/demo",
      minPalimvo: "0.1.0",
      permissions: {
        read: ["notes/**"],
        write: ["notes"],
        network: ["api.example.com", "*.cdn.example.com"],
      },
      dependencies: { kanban: "^1.0.0" },
      contributes: {
        views: [{ id: "board", name: "Board", icon: "layout" }],
        codeBlocks: [{ language: "demo" }],
        components: [{ type: "gauge-x", name: "Gauge" }],
        fileTypes: [{ extension: "nbs", mime: "application/x-nbs", maxBytes: 1000 }],
        viewers: [{ id: "v", name: "Viewer", extensions: ["nbs", "json"] }],
        baseViews: [{ type: "timeline", name: "Timeline" }],
        homeWidgets: [{ id: "w", name: "Widget", size: "small" }],
        extensionPoints: [{ id: "badge" }],
        extensions: [{ plugin: "kanban", point: "card-badge" }],
        slots: [{ slot: "toolbar", id: "go", title: "Go" }],
        theme: { name: "Night", css: "theme.css" },
        app: { name: "App" },
        tools: [
          {
            name: "do_it",
            description: "Does it",
            inputSchema: { type: "object", properties: { a: { type: "string" } } },
          },
        ],
      },
      server: "server.js",
      locales: { en: "locales/en.json" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(referencedFiles(r.manifest).sort()).toEqual(
        ["locales/en.json", "main.js", "manifest.json", "server.js", "theme.css"].sort(),
      );
    }
  });

  it("refuses version 1 manifests and points at the converter", () => {
    const [issue] = issues({ id: "old", version: "1", name: "Old", permissions: ["read"] });
    expect(issue?.code).toBe("unsupported_version");
    expect(issue?.message).toContain("convertLegacyManifest");
  });

  it("refuses non-objects and unknown keys", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
    expect(codes({ ...base, colour: "red" })).toContain("colour:unknown_key");
    expect(codes({ ...base, contributes: { widgets: [] } })).toContain(
      "contributes.widgets:unknown_key",
    );
  });

  it("checks id, version and names", () => {
    expect(codes({ ...base, id: "Bad Id" })).toContain("id:invalid_format");
    expect(codes({ ...base, id: "a.b" })).toContain("id:invalid_format");
    expect(codes({ ...base, version: "1.0" })).toContain("version:invalid_format");
    expect(codes({ ...base, name: { "zh-TW": "示範" } })).toContain("name:missing_english");
    expect(codes({ ...base, name: { en: "x", "not a locale": "y" } })).toContain(
      "name.not a locale:invalid_locale",
    );
    expect(codes({ ...base, name: "x".repeat(MANIFEST_LIMITS.nameLength + 1) })).toContain(
      "name:too_long",
    );
    expect(codes({ ...base, homepage: "http://example.com" })).toContain("homepage:invalid_format");
  });

  it("checks minPalimvo against the running version", () => {
    const input = { ...base, minPalimvo: "0.3.0" };
    expect(validateManifest(input, { palimvoVersion: "0.3.1" }).ok).toBe(true);
    const r = validateManifest(input, { palimvoVersion: "0.2.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe("incompatible");
    expect(codes({ ...base, minPalimvo: "latest" })).toContain("minPalimvo:invalid_format");
  });

  describe("permissions", () => {
    it("accepts false or a list for network and warns about powerful grants", () => {
      const r = validateManifest({
        ...base,
        permissions: { write: ["**"], network: ["*"] },
      });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.warnings.map((w) => w.code).sort()).toEqual([
          "network_unrestricted",
          "write_whole_vault",
        ]);
      expect(validateManifest({ ...base, permissions: { network: false } }).ok).toBe(true);
      expect(validateManifest({ ...base, permissions: { network: [] } }).ok).toBe(true);
    });

    it("refuses legacy array form, bad globs and bad hosts", () => {
      expect(codes({ ...base, permissions: ["read"] })).toContain("permissions:invalid_type");
      expect(codes({ ...base, permissions: { read: ["../x"] } })).toContain(
        "permissions.read[0]:invalid_glob",
      );
      expect(codes({ ...base, permissions: { read: ["/abs"] } })).toContain(
        "permissions.read[0]:invalid_glob",
      );
      expect(codes({ ...base, permissions: { write: [""] } })).toContain(
        "permissions.write[0]:invalid_glob",
      );
      expect(codes({ ...base, permissions: { read: ["a/**b"] } })).toContain(
        "permissions.read[0]:invalid_glob",
      );
      expect(codes({ ...base, permissions: { network: ["https://x.com"] } })).toContain(
        "permissions.network[0]:invalid_host",
      );
      expect(codes({ ...base, permissions: { network: true } })).toContain(
        "permissions.network:invalid_type",
      );
      expect(codes({ ...base, permissions: { admin: [] } })).toContain(
        "permissions.admin:unknown_key",
      );
    });
  });

  describe("dependencies", () => {
    it("checks ids and ranges", () => {
      expect(validateManifest({ ...base, dependencies: { other: ">=1.0.0 <2.0.0" } }).ok).toBe(
        true,
      );
      expect(codes({ ...base, dependencies: { other: "banana" } })).toContain(
        "dependencies.other:invalid_range",
      );
      expect(codes({ ...base, dependencies: { Other: "*" } })).toContain(
        "dependencies.Other:invalid_format",
      );
      expect(codes({ ...base, dependencies: { demo: "*" } })).toContain(
        "dependencies.demo:self_dependency",
      );
    });

    it("requires contributed-to plugins to be dependencies", () => {
      expect(
        codes({ ...base, contributes: { extensions: [{ plugin: "kanban", point: "badge" }] } }),
      ).toContain("contributes.extensions[0].plugin:missing_dependency");
    });
  });

  describe("contributes", () => {
    it("refuses duplicates and reserved names", () => {
      const dup = {
        views: [
          { id: "a", name: "A" },
          { id: "a", name: "B" },
        ],
      };
      expect(codes({ ...base, contributes: dup })).toContain("contributes.views[1]:duplicate");
      expect(codes({ ...base, contributes: { codeBlocks: [{ language: "mermaid" }] } })).toContain(
        "contributes.codeBlocks[0].language:reserved",
      );
      expect(
        codes({ ...base, contributes: { baseViews: [{ type: "table", name: "T" }] } }),
      ).toContain("contributes.baseViews[0].type:reserved");
    });

    it("keeps file types inert", () => {
      const ft = (t: object) => codes({ ...base, contributes: { fileTypes: [t] } });
      expect(ft({ extension: "md" })).toContain("contributes.fileTypes[0].extension:reserved");
      expect(ft({ extension: "x", mime: "text/html" })).toContain(
        "contributes.fileTypes[0].mime:unsafe_mime",
      );
      expect(ft({ extension: "x", mime: "image/svg+xml" })).toContain(
        "contributes.fileTypes[0].mime:unsafe_mime",
      );
      expect(ft({ extension: "x", maxBytes: 0 })).toContain(
        "contributes.fileTypes[0].maxBytes:out_of_range",
      );
      expect(ft({ extension: ".x" })).toContain(
        "contributes.fileTypes[0].extension:invalid_format",
      );
    });

    it("needs read access for viewers and rejects editor extensions", () => {
      const viewer = { viewers: [{ id: "v", name: "V", extensions: ["json"] }] };
      expect(codes({ ...base, contributes: viewer })).toContain(
        "contributes.viewers[0]:needs_read",
      );
      expect(
        validateManifest({ ...base, permissions: { read: ["**"] }, contributes: viewer }).ok,
      ).toBe(true);
      expect(
        codes({
          ...base,
          permissions: { read: ["**"] },
          contributes: { viewers: [{ id: "v", name: "V", extensions: ["md"] }] },
        }),
      ).toContain("contributes.viewers[0].extensions[0]:reserved");
    });

    it("checks slots, theme and app", () => {
      expect(
        codes({ ...base, contributes: { slots: [{ slot: "sidebar", id: "x", title: "X" }] } }),
      ).toContain("contributes.slots[0].slot:invalid_value");
      expect(codes({ ...base, contributes: { theme: { name: "N", css: "../x.css" } } })).toContain(
        "contributes.theme.css:invalid_format",
      );
      expect(codes({ ...base, contributes: { theme: { name: "N", css: "theme.js" } } })).toContain(
        "contributes.theme.css:invalid_format",
      );
    });

    it("enforces the count limits", () => {
      const views = Array.from({ length: MANIFEST_LIMITS.views + 1 }, (_, i) => ({
        id: `v${i}`,
        name: "V",
      }));
      expect(codes({ ...base, contributes: { views } })).toContain("contributes.views:too_many");
    });
  });

  describe("tools", () => {
    const tool = { name: "go", description: "Go", inputSchema: { type: "object" } };

    it("needs a server entry", () => {
      expect(codes({ ...base, contributes: { tools: [tool] } })).toContain("server:required");
      expect(
        validateManifest({ ...base, server: "server.js", contributes: { tools: [tool] } }).ok,
      ).toBe(true);
    });

    it("checks names and schemas", () => {
      const t = (x: object) =>
        codes({ ...base, server: "server.js", contributes: { tools: [{ ...tool, ...x }] } });
      expect(t({ name: "Go.Now" })).toContain("contributes.tools[0].name:invalid_format");
      expect(t({ inputSchema: { type: "string" } })).toContain(
        "contributes.tools[0].inputSchema:invalid_schema",
      );
      expect(
        t({
          inputSchema: { type: "object", properties: { a: { $ref: "https://evil.example/s" } } },
        }),
      ).toContain("contributes.tools[0].inputSchema:invalid_schema");
      expect(
        validateManifest({
          ...base,
          server: "server.js",
          contributes: {
            tools: [
              {
                ...tool,
                inputSchema: { type: "object", properties: { a: { $ref: "#/$defs/a" } } },
              },
            ],
          },
        }).ok,
      ).toBe(true);
      expect(
        t({
          inputSchema: {
            type: "object",
            description: "x".repeat(MANIFEST_LIMITS.inputSchemaBytes),
          },
        }),
      ).toContain("contributes.tools[0].inputSchema:too_long");
    });
  });

  it("handles inherited names, null entries and multibyte schemas", () => {
    const ext = { extensions: [{ plugin: "constructor", point: "x" }] };
    expect(codes({ ...base, contributes: ext })).toContain(
      "contributes.extensions[0].plugin:missing_dependency",
    );
    expect(() => validateManifest({ ...base, contributes: { extensions: [null] } })).not.toThrow();
    expect(codes({ ...base, contributes: { extensions: [null] } })).toContain(
      "contributes.extensions[0]:invalid_type",
    );
    const big = { type: "object", description: "字".repeat(6000) };
    const tool = { name: "go", description: "Go", inputSchema: big };
    expect(codes({ ...base, server: "server.js", contributes: { tools: [tool] } })).toContain(
      "contributes.tools[0].inputSchema:too_long",
    );
  });

  it("refuses entry files that escape the package", () => {
    expect(codes({ ...base, main: "../main.js" })).toContain("main:invalid_format");
    expect(codes({ ...base, main: "/main.js" })).toContain("main:invalid_format");
    expect(codes({ ...base, main: "main.txt" })).toContain("main:invalid_format");
    expect(codes({ ...base, locales: { en: "../en.json" } })).toContain(
      "locales.en:invalid_format",
    );
  });

  it("reports every problem at once", () => {
    expect(
      issues({ ...base, id: "X", version: "z", permissions: { read: ["/"] } }).length,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("parseManifest", () => {
  it("returns the manifest or throws with all issues", () => {
    expect(parseManifest(base).id).toBe("demo");
    expect(() => parseManifest({ ...base, id: "X", version: "z" })).toThrow(/id:[\s\S]*version:/);
  });
});

describe("resolveLocalized", () => {
  const text = { en: "Board", "zh-TW": "看板" };
  it("prefers the exact locale, then the language, then English", () => {
    expect(resolveLocalized(text, "zh-TW")).toBe("看板");
    expect(resolveLocalized({ ...text, zh: "板" }, "zh-CN")).toBe("板");
    expect(resolveLocalized(text, "fr")).toBe("Board");
    expect(resolveLocalized("Plain", "fr")).toBe("Plain");
    expect(resolveLocalized(undefined, "en")).toBe("");
  });
});
