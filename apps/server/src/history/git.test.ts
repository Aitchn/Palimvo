import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "@palimvo/core";
import { assertGit } from "./git.ts";

const originalPath = process.env.PATH;
const originalPathWin = process.env.Path;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalPathWin !== undefined) process.env.Path = originalPathWin;
});

describe("git", () => {
  it("reports the installed version", async () => {
    expect(await assertGit()).toMatch(/^git version \d+\.\d+/);
  });

  it("says plainly when git is not installed", async () => {
    process.env.PATH = "";
    if (originalPathWin !== undefined) process.env.Path = "";
    const err = await assertGit().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "git_unavailable", httpStatus: 503 });
    expect((err as AppError).message).toMatch(/Install git/);
  });
});
