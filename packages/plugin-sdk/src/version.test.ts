import { describe, expect, it } from "vitest";
import { compareVersions, isStrictVersion, isVersionRange, satisfiesVersion } from "./version.ts";

describe("versions", () => {
  it("compares numerically with pre-releases first", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.0.0-alpha-one", "1.0.0-alpha-two")).toBe(-1);
    expect(satisfiesVersion("1.0.0-alpha-two", "1.0.0-alpha-one")).toBe(false);
  });

  it("recognizes strict plugin versions", () => {
    expect(isStrictVersion("1.2.3")).toBe(true);
    expect(isStrictVersion("1.2.3-beta.1")).toBe(true);
    for (const bad of ["1.2", "01.2.3", "v1.2.3", "1.2.3.4", ""])
      expect(isStrictVersion(bad)).toBe(false);
  });

  it("evaluates ranges", () => {
    expect(satisfiesVersion("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfiesVersion("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesVersion("0.2.5", "^0.2.1")).toBe(true);
    expect(satisfiesVersion("0.3.0", "^0.2.1")).toBe(false);
    expect(satisfiesVersion("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfiesVersion("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfiesVersion("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesVersion("3.0.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfiesVersion("9.9.9", "*")).toBe(true);
    expect(satisfiesVersion("1.0.0", undefined)).toBe(true);
    expect(satisfiesVersion("1.0.0", "banana")).toBe(false);
  });

  it("rejects malformed ranges", () => {
    expect(isVersionRange("^1.0.0 ||")).toBe(false);
    expect(isVersionRange("1.x.y")).toBe(false);
    expect(isVersionRange(">=1.0.0 <2.0.0")).toBe(true);
  });
});
