import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv } from "./csv.ts";
import { viewerKind } from "./kinds.ts";

describe("parseCsv", () => {
  it("splits rows and cells", () => {
    expect(parseCsv("a,b,c\n1,2,3\n").rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps delimiters, quotes and line breaks inside quoted cells", () => {
    const { rows } = parseCsv('name,note\r\n"Smith, Ann","said ""hi""\nand left"\r\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Smith, Ann", 'said "hi"\nand left'],
    ]);
  });

  it("drops a byte order mark and blank lines, and keeps ragged rows as they are", () => {
    expect(parseCsv("﻿a,b\n\n1\n3,4,5").rows).toEqual([["a", "b"], ["1"], ["3", "4", "5"]]);
    expect(parseCsv("").rows).toEqual([]);
  });

  it("guesses the delimiter from the first line", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(detectDelimiter('"a;b",c\n')).toBe(",");
    expect(parseCsv("x;y\n1;2").rows[1]).toEqual(["1", "2"]);
  });

  it("stops at the row limit and says so", () => {
    const text = Array.from({ length: 50 }, (_, i) => `r${i},x`).join("\n");
    const small = parseCsv(text, 10);
    expect(small.rows).toHaveLength(10);
    expect(small.truncated).toBe(true);
    expect(parseCsv(text, 50).truncated).toBe(false);
  });
});

describe("viewerKind", () => {
  it("picks a viewer by extension", () => {
    expect(viewerKind("a/Photo.JPG")).toBe("image");
    expect(viewerKind("song.mp3")).toBe("audio");
    expect(viewerKind("clip.mp4")).toBe("video");
    expect(viewerKind("doc.pdf")).toBe("pdf");
    expect(viewerKind("data.json")).toBe("json");
    expect(viewerKind("t.csv")).toBe("csv");
    expect(viewerKind("c.yml")).toBe("yaml");
    expect(viewerKind("c.yaml")).toBe("yaml");
    expect(viewerKind("n.txt")).toBe("text");
    expect(viewerKind("logo.svg")).toBe("svg");
    expect(viewerKind("tune.nbs")).toBe("none");
    expect(viewerKind("README")).toBe("none");
  });
});
