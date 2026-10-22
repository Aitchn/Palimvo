import { describe, expect, it } from "vitest";
import { hunkDisplay } from "./lines.ts";

const lines = (h: Parameters<typeof hunkDisplay>[0]) =>
  hunkDisplay(h).map((l) => `${l.kind === "del" ? "-" : l.kind === "add" ? "+" : ""}${l.text}`);

describe("hunkDisplay", () => {
  it("shows the whole line an inline change sits in", () => {
    expect(
      lines({
        before: "March",
        after: "April",
        contextBefore: "# Plan\n\nWe ship in ",
        contextAfter: ".\n\nOwner: Dana\n",
      }),
    ).toEqual(["# Plan", "", "-We ship in March.", "+We ship in April.", "", "Owner: Dana"]);
  });

  it("shows a replaced block of lines and its neighbours", () => {
    expect(
      lines({
        before: "beta\n",
        after: "BETA\nBETA 2\n",
        contextBefore: "alpha\n",
        contextAfter: "gamma\n",
      }),
    ).toEqual(["alpha", "-beta", "+BETA", "+BETA 2", "gamma"]);
  });

  it("shows an insertion as added lines only", () => {
    expect(
      lines({ before: "", after: "new line\n", contextBefore: "a\n", contextAfter: "b\n" }),
    ).toEqual(["a", "+new line", "b"]);
    expect(lines({ before: "", after: "# New\n", contextBefore: "", contextAfter: "" })).toEqual([
      "+# New",
    ]);
  });

  it("shows a deletion as removed lines only", () => {
    expect(
      lines({ before: "two\n", after: "", contextBefore: "one\n", contextAfter: "three\n" }),
    ).toEqual(["one", "-two", "three"]);
  });

  it("keeps at most two lines of context on each side", () => {
    expect(
      lines({
        before: "x",
        after: "y",
        contextBefore: "1\n2\n3\n4\n",
        contextAfter: "\n5\n6\n7\n",
      }),
    ).toEqual(["3", "4", "-x", "+y", "5", "6"]);
  });
});
