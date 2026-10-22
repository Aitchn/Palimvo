import { makeAuthor } from "@palimvo/core";
import { describe, expect, it } from "vitest";
import type { CommitInfo } from "../history/history.ts";
import { summarizeActivity } from "./activity.ts";

const commit = (
  id: string,
  author: ReturnType<typeof makeAuthor>,
  date: string,
  files: string[],
): CommitInfo => ({
  id,
  date,
  author,
  coAuthors: [],
  approvedBy: [],
  subject: id,
  body: "",
  reasons: [],
  checkpoint: false,
  tags: [],
  files,
});

const ada = makeAuthor("human", "Ada");
const claude = makeAuthor("ai", "Claude");
const plugin = makeAuthor("plugin", "Kanban", { client: "Claude" });
const outside = makeAuthor("external", "External change", { id: "external" });

const log = [
  commit("5", claude, "2026-10-22T05:00:00Z", ["a.md"]),
  commit("4", ada, "2026-10-22T04:00:00Z", ["b.md", ".palimvo/home.json"]),
  commit("3", plugin, "2026-10-22T03:00:00Z", ["c.md"]),
  commit("2", ada, "2026-10-22T02:00:00Z", [".palimvo/home.json"]),
  commit("1", outside, "2026-10-22T01:00:00Z", ["d.md"]),
];

describe("summarizeActivity", () => {
  it("drops the app's own files and commits that touched nothing else", () => {
    const result = summarizeActivity(log, "all", 30);
    expect(result.entries.map((c) => c.id)).toEqual(["5", "4", "3", "1"]);
    expect(result.entries[1]!.files).toEqual(["b.md"]);
  });

  it("filters people and AIs (plugins count as AI) but counts everyone", () => {
    expect(summarizeActivity(log, "human", 30).entries.map((c) => c.id)).toEqual(["4"]);
    expect(summarizeActivity(log, "ai", 30).entries.map((c) => c.id)).toEqual(["5", "3"]);
    const authors = summarizeActivity(log, "human", 30).authors;
    expect(authors.map((a) => [a.author.name, a.count])).toEqual([
      ["Claude", 1],
      ["Ada", 1],
      ["Kanban", 1],
      ["External change", 1],
    ]);
  });

  it("limits the entries and keeps the most recently active author first", () => {
    const result = summarizeActivity(log, "all", 2);
    expect(result.entries).toHaveLength(2);
    expect(result.authors[0]!.author.name).toBe("Claude");
    expect(result.authors[0]!.lastAt).toBe("2026-10-22T05:00:00Z");
  });

  it("keeps commits without files, such as checkpoints", () => {
    const result = summarizeActivity([commit("c", ada, "2026-10-22T06:00:00Z", [])], "all", 5);
    expect(result.entries).toHaveLength(1);
  });
});
