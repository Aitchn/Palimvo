import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.ts";

describe("parseDiff", () => {
  it("keeps hunks and changed lines and drops file headers", () => {
    const lines = parseDiff(
      [
        "diff --git a/n.md b/n.md",
        "index 1..2 100644",
        "--- a/n.md",
        "+++ b/n.md",
        "@@ -1 +1 @@",
        "-first",
        "+second",
        " same",
        "",
      ].join("\n"),
    );
    expect(lines).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "del", text: "first" },
      { kind: "add", text: "second" },
      { kind: "context", text: "same" },
    ]);
  });

  it("does not take a removed line that starts with dashes for a header", () => {
    const lines = parseDiff("diff --git a/x b/x\n@@ -1 +0,0 @@\n--- a\n");
    expect(lines.at(-1)).toEqual({ kind: "del", text: "-- a" });
  });

  it("notes renames and binary files that have no hunks", () => {
    const lines = parseDiff(
      "diff --git a/a.md b/b.md\nsimilarity index 100%\nrename from a.md\nrename to b.md\n" +
        "diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n",
    );
    expect(lines.map((l) => l.text)).toEqual([
      "rename from a.md",
      "rename to b.md",
      "Binary files a/i.png and b/i.png differ",
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
