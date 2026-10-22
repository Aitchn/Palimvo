import { describe, expect, it } from "vitest";
import { searchTerms } from "./search.ts";

describe("searchTerms", () => {
  it("splits at whitespace and lower-cases", () => {
    expect(searchTerms("  Hello   WORLD ")).toEqual(["hello", "world"]);
  });
  it("keeps a quoted phrase together", () => {
    expect(searchTerms('plan "Big Picture" 2026')).toEqual(["plan", "big picture", "2026"]);
  });
  it("ignores empty input and empty quotes", () => {
    expect(searchTerms("")).toEqual([]);
    expect(searchTerms(' "" ')).toEqual([]);
  });
  it("leaves Chinese text in one term", () => {
    expect(searchTerms("決策 紀錄")).toEqual(["決策", "紀錄"]);
  });
});
