import { describe, expect, it } from "vitest";
import type { TreeNode } from "@palimvo/core";
import { hashPassword, verifyPassword, assertPasswordAllowed } from "./password.ts";
import { PublicPolicy } from "./publicPolicy.ts";
import { FailureLimiter } from "./rateLimit.ts";

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password here")).not.toBe(
      await hashPassword("same password here"),
    );
  });

  it("treats equivalent unicode forms as the same password", async () => {
    const hash = await hashPassword("café society!!");
    expect(await verifyPassword("café society!!", hash)).toBe(true);
  });

  it("rejects malformed stored hashes", async () => {
    for (const bad of ["", "plain", "scrypt$1$2$3$a", "bcrypt$1$2$3$a$b", "scrypt$x$8$1$a$b"])
      expect(await verifyPassword("whatever-long", bad)).toBe(false);
  });

  it("enforces the length limits", () => {
    expect(() => assertPasswordAllowed("short")).toThrow();
    expect(() => assertPasswordAllowed("x".repeat(257))).toThrow();
    expect(() => assertPasswordAllowed("x".repeat(10))).not.toThrow();
  });
});

describe("FailureLimiter", () => {
  it("blocks after the maximum and releases after the window", () => {
    let now = 1_000_000;
    const l = new FailureLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(l.retryAfterSeconds("a")).toBe(0);
      l.fail("a");
      now += 1000;
    }
    expect(l.retryAfterSeconds("a")).toBeGreaterThan(0);
    expect(l.retryAfterSeconds("b")).toBe(0);
    now += 61_000;
    expect(l.retryAfterSeconds("a")).toBe(0);
  });

  it("forgets a key when cleared", () => {
    const l = new FailureLimiter(1, 60_000);
    l.fail("a");
    expect(l.retryAfterSeconds("a")).toBeGreaterThan(0);
    l.clear("a");
    expect(l.retryAfterSeconds("a")).toBe(0);
  });
});

const file = (path: string): TreeNode => ({ name: path.split("/").at(-1)!, path, type: "file" });
const folder = (path: string, children: TreeNode[]): TreeNode => ({
  name: path.split("/").at(-1)!,
  path,
  type: "folder",
  children,
});

describe("PublicPolicy", () => {
  const tree = [
    file("home.md"),
    folder("docs", [file("docs/a.md"), folder("docs/deep", [file("docs/deep/b.md")])]),
    folder("private", [
      file("private/secret.md"),
      folder("private/open", [file("private/open/x.md")]),
    ]),
  ];

  it("covers listed files, folders and what lies inside them", () => {
    const p = new PublicPolicy(["docs", "home.md"]);
    expect(p.covers("home.md")).toBe(true);
    expect(p.covers("docs/deep/b.md")).toBe(true);
    expect(p.covers("Docs/A.md")).toBe(false); // exact, as on a case-sensitive disk
    expect(p.covers("private/secret.md")).toBe(false);
    expect(p.covers("docsx/a.md")).toBe(false);
  });

  it("covers everything except hidden paths when the vault is public", () => {
    const p = new PublicPolicy([""]);
    expect(p.covers("private/secret.md")).toBe(true);
    expect(p.covers(".palimvo/config.json")).toBe(false);
    expect(p.covers("docs/.git/config")).toBe(false);
  });

  it("shows only public entries and the folders leading to them", () => {
    const p = new PublicPolicy(["private/open", "home.md"]);
    expect(p.filterTree(tree).map((n) => n.path)).toEqual(["home.md", "private"]);
    const priv = p.filterTree(tree).find((n) => n.path === "private");
    expect(priv?.children?.map((n) => n.path)).toEqual(["private/open"]);
  });

  it("shows nothing when nothing is public", () => {
    expect(new PublicPolicy([]).filterTree(tree)).toEqual([]);
  });
});
