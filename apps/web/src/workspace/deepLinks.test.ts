import { describe, expect, it } from "vitest";
import { fileHref, pathFromLocation, vaultHref } from "./deepLinks.ts";

describe("deep links", () => {
  it("encodes each part but keeps the slashes", () => {
    expect(vaultHref("my vault")).toBe("/v/my%20vault");
    expect(fileHref("v", "專案/a b#1.md")).toBe("/v/v/%E5%B0%88%E6%A1%88/a%20b%231.md");
  });

  it("reads the path back and tidies stray slashes", () => {
    expect(pathFromLocation("Projects/Plan.md")).toBe("Projects/Plan.md");
    expect(pathFromLocation("/Projects//Plan.md/")).toBe("Projects/Plan.md");
    expect(pathFromLocation(undefined)).toBe("");
  });
});
