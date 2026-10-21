import { describe, expect, it } from "vitest";
import {
  declaredFileType,
  fileExtension,
  isTextDocument,
  supportedFileType,
  type VaultFileType,
} from "./file-types.ts";

const nbs: VaultFileType = {
  extension: "nbs",
  mime: "application/octet-stream",
  maxBytes: 1024,
  plugins: ["player"],
};

describe("file types", () => {
  it("reads the extension of the last path segment", () => {
    expect(fileExtension("a.b/Song.NBS")).toBe("nbs");
    expect(fileExtension("folder.x/README")).toBe("");
    expect(fileExtension(".gitkeep")).toBe("");
  });

  it("combines built-in types with those plugins register", () => {
    expect(supportedFileType("x/a.md")?.source).toBe("note");
    expect(supportedFileType("x/a.canvas")).toEqual({ source: "note", mime: "application/json" });
    expect(supportedFileType("x/a.png")).toEqual({ source: "media", mime: "image/png" });
    expect(supportedFileType("x/a.pdf")?.source).toBe("document");
    expect(supportedFileType("x/a.yaml")).toEqual({
      source: "document",
      mime: "text/yaml; charset=utf-8",
    });
    expect(supportedFileType("x/a.svg")).toEqual({
      source: "document",
      mime: "text/plain; charset=utf-8",
    });
    expect(supportedFileType("x/a.nbs")).toBeUndefined();
    expect(supportedFileType("x/a.nbs", [nbs])).toEqual({
      source: "plugin",
      mime: nbs.mime,
      maxBytes: 1024,
      plugins: ["player"],
    });
    expect(supportedFileType("x/a.exe", [nbs])).toBeUndefined();
    expect(supportedFileType("x/.nbs", [nbs])).toBeUndefined();
  });

  it("finds the declared type by extension only", () => {
    expect(declaredFileType("a/B.NBS", [nbs])).toBe(nbs);
    expect(declaredFileType("a/b", [nbs])).toBeUndefined();
  });

  it("knows which documents are plain text", () => {
    expect(["a.json", "b/c.YML", "d.yaml", "e.txt", "f.csv", "g.svg"].every(isTextDocument)).toBe(
      true,
    );
    expect(["a.pdf", "a.md", "a.png", "a.nbs"].some(isTextDocument)).toBe(false);
  });
});
