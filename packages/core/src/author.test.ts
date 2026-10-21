import { expect, it } from "vitest";
import {
  authorFromGit,
  cleanName,
  formatAuthor,
  gitAuthorString,
  gitEmail,
  makeAuthor,
  parseAuthor,
  sameAuthor,
  slugify,
} from "./author.ts";

it("slugifies names", () => {
  expect(slugify("Claude Code")).toBe("claude-code");
  expect(slugify("  ChatGPT (OpenAI)! ")).toBe("chatgpt-openai");
  expect(slugify("日本語")).toBe("unknown");
});

it("formats git identities with the palimvo.local domain", () => {
  const ai = makeAuthor("ai", "Claude Code");
  expect(gitEmail(ai)).toBe("claude-code@ai.palimvo.local");
  expect(gitAuthorString(ai)).toBe("Claude Code <claude-code@ai.palimvo.local>");
});

it("round-trips authors through headers", () => {
  for (const a of [
    makeAuthor("human", "Ann Lee"),
    makeAuthor("ai", "Claude Code"),
    makeAuthor("plugin", "Kanban", { client: "Claude Code" }),
  ]) {
    expect(parseAuthor(formatAuthor(a))).toEqual(a);
  }
});

it("rejects malformed headers", () => {
  for (const bad of [null, undefined, "", "nocolon", "robot:x", "ai:", "%E0%A4%A", "ai:<>"])
    expect(parseAuthor(bad)).toBeNull();
});

it("strips control characters and brackets from names", () => {
  expect(cleanName("a<b>\nc")).toBe("a b c");
  expect(cleanName("x".repeat(200))).toHaveLength(80);
});

it("recovers authors from git name/email", () => {
  expect(authorFromGit("Claude Code", "claude-code@ai.palimvo.local")).toEqual({
    kind: "ai",
    id: "claude-code",
    name: "Claude Code",
  });
  expect(authorFromGit("Bob", "bob@example.com")).toMatchObject({ kind: "external", name: "Bob" });
  expect(authorFromGit("Evil", "x@bogus.palimvo.local").kind).toBe("external");
});

it("compares by kind and id", () => {
  expect(sameAuthor(makeAuthor("ai", "Claude Code"), makeAuthor("ai", "claude  code"))).toBe(true);
  expect(sameAuthor(makeAuthor("ai", "Ann"), makeAuthor("human", "Ann"))).toBe(false);
});
