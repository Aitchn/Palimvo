import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatAuthor, makeAuthor, type Author } from "@palimvo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommitInfo } from "../src/history/history.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;
let vaultDir: string;

beforeEach(async () => {
  server = await startTestServer();
  expect((await post("/api/vaults", { id: "demo" })).status).toBe(201);
  vaultDir = path.join(server.dataDir, "vaults", "demo");
});
afterEach(() => server.dispose());

const claude = makeAuthor("ai", "Claude");
const gpt = makeAuthor("ai", "GPT");
const aitchn = makeAuthor("human", "Aitchn");

function headers(author?: Author, reason?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(author ? { "x-palimvo-author": formatAuthor(author) } : {}),
    ...(reason ? { "x-palimvo-reason": encodeURIComponent(reason) } : {}),
  };
}
const send = (method: string, p: string, body?: unknown, author?: Author, reason?: string) =>
  server.fetch(p, {
    method,
    headers: headers(author, reason),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const post = (p: string, body: unknown, author?: Author, reason?: string) =>
  send("POST", p, body, author, reason);
const put = (file: string, content: string, author?: Author, reason?: string) =>
  send("PUT", `/api/vaults/demo/files/${file}`, { content }, author, reason);
const commit = () => server.services.history.commit("demo");
const log = async (file?: string): Promise<CommitInfo[]> =>
  (
    (await (
      await server.fetch(
        `/api/vaults/demo/history${file ? `?path=${encodeURIComponent(file)}` : ""}`,
      )
    ).json()) as { commits: CommitInfo[] }
  ).commits;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: vaultDir, maxBuffer: 64 << 20 }).toString();

describe("version history", () => {
  it("starts every vault with a commit of its files", async () => {
    const commits = await log();
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      subject: "Create version history",
      author: { kind: "external", name: "Palimvo" },
    });
    expect(commits[0]!.files).toContain("Welcome.md");
    expect(commits[0]!.files).toContain(".palimvo/config.json");
  });

  it("commits changes per author with their reasons as trailers", async () => {
    await put("a.md", "from claude\n", claude, "Tidy the meeting notes");
    await put("b.md", "from gpt\n", gpt);
    await put("c.md", "from a person\n", aitchn);
    await writeFile(path.join(vaultDir, "outside.md"), "edited in Obsidian desktop\n");
    await commit();

    const commits = await log();
    const byAuthor = Object.fromEntries(commits.slice(0, 4).map((c) => [c.author.name, c]));
    expect(byAuthor.Claude).toMatchObject({
      subject: "Tidy the meeting notes",
      reasons: ["Tidy the meeting notes"],
      files: ["a.md"],
      author: { kind: "ai", id: "claude" },
    });
    expect(byAuthor.GPT).toMatchObject({ subject: "Update b.md", files: ["b.md"], reasons: [] });
    expect(byAuthor.Aitchn).toMatchObject({ files: ["c.md"], author: { kind: "human" } });
    expect(byAuthor["External change"]).toMatchObject({
      files: ["outside.md"],
      author: { kind: "external" },
    });

    const message = git(
      "log",
      "-1",
      "--format=%B",
      commits.find((c) => c.author.name === "Claude")!.id,
    );
    expect(message).toContain("Palimvo-Author: ai:Claude");
    expect(message).toContain("Palimvo-Reason: Tidy the meeting notes");
    expect(git("log", "-1", "--format=%ae", commits[commits.length - 2]!.id)).toMatch(/@/);
  });

  it("credits everyone who touched a file and keeps internal files out", async () => {
    await put("n.md", "one\n", claude);
    await put("n.md", "one\ntwo\n", aitchn);
    await mkdir(path.join(vaultDir, ".palimvo", "collab"), { recursive: true });
    await writeFile(path.join(vaultDir, ".palimvo", "collab", "doc.bin"), "state");
    await writeFile(path.join(vaultDir, ".stale.md.tmp-0123abcd"), "half written");
    await commit();
    const [latest] = await log("n.md");
    expect(latest).toMatchObject({ author: { name: "Aitchn" } });
    expect(latest!.coAuthors).toEqual([expect.objectContaining({ name: "Claude", kind: "ai" })]);
    const tracked = git("ls-files");
    expect(tracked).not.toContain("collab");
    expect(tracked).not.toContain(".tmp-");
    expect(tracked).toContain(".palimvo/config.json");
  });

  it("writes two commits when two authors write at the same time", async () => {
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => put(`claude-${i}.md`, `c${i}\n`, claude)),
      ...Array.from({ length: 10 }, (_, i) => put(`gpt-${i}.md`, `g${i}\n`, gpt)),
    ]);
    const made = await commit();
    expect(made).toHaveLength(2);
    expect(made.map((c) => c.author.name).sort()).toEqual(["Claude", "GPT"]);
    for (const c of made) expect(c.files).toHaveLength(10);
  });

  it("shows, diffs and restores old versions, and follows renames", async () => {
    await put("n.md", "first\n", aitchn);
    await commit();
    await put("n.md", "second\n", claude);
    await commit();
    const [second, first] = await log("n.md");

    const diff = (await (
      await server.fetch(`/api/vaults/demo/history/${second!.id}/diff?path=n.md`)
    ).json()) as { diff: string };
    expect(diff.diff).toContain("-first\n+second");
    expect(
      await (await server.fetch(`/api/vaults/demo/history/${first!.id}/file?path=n.md`)).json(),
    ).toEqual({ path: "n.md", content: "first\n" });

    const res = await post("/api/vaults/demo/restore", { path: "n.md", commit: first!.id }, aitchn);
    expect(res.status).toBe(200);
    expect(await readFile(path.join(vaultDir, "n.md"), "utf8")).toBe("first\n");
    await commit();
    expect((await log("n.md"))[0]).toMatchObject({
      subject: `Restore n.md to ${first!.id.slice(0, 7)}`,
      author: { name: "Aitchn" },
    });

    await post("/api/vaults/demo/move", { from: "n.md", to: "moved/n.md" }, aitchn);
    await commit();
    const moved = await log("moved/n.md");
    expect(moved[0]!.path).toBe("moved/n.md");
    const before = moved.find((c) => c.id === first!.id)!;
    expect(before.path).toBe("n.md");
    const back = await post("/api/vaults/demo/restore", {
      path: "moved/n.md",
      commit: second!.id,
      from: "n.md",
    });
    expect(back.status).toBe(200);
    expect(await readFile(path.join(vaultDir, "moved", "n.md"), "utf8")).toBe("second\n");

    expect((await server.fetch("/api/vaults/demo/history/nothex/diff")).status).toBe(404);
    expect(
      (await server.fetch(`/api/vaults/demo/history/${first!.id}/file?path=missing.md`)).status,
    ).toBe(404);
    expect((await server.fetch("/api/vaults/nope/history")).status).toBe(404);
  });

  it("compares any two versions and lists changes that are still waiting to be committed", async () => {
    await put("c.md", "one\n", aitchn);
    await commit();
    await put("c.md", "two\n", claude, "Reworded");
    await commit();
    await put("c.md", "three\n", gpt, "Final wording");
    // No commit() here: listing the history commits what is pending.
    const [third, second, first] = await log("c.md");
    expect(third).toMatchObject({
      author: { kind: "ai", name: "GPT" },
      reasons: ["Final wording"],
    });

    const compare = async (from: string, to: string) =>
      (await (
        await server.fetch(`/api/vaults/demo/history/compare?from=${from}&to=${to}&path=c.md`)
      ).json()) as { diff: string };
    const wide = (await compare(first!.id, third!.id)).diff;
    expect(wide).toContain("-one\n+three");
    expect(wide).not.toContain("two");
    expect((await compare(second!.id, third!.id)).diff).toContain("-two\n+three");
    expect(
      (await server.fetch(`/api/vaults/demo/history/compare?from=nothex&to=${third!.id}`)).status,
    ).toBe(404);
  });

  it("restores a deleted file", async () => {
    await put("gone.md", "still here\n", aitchn);
    await commit();
    const [added] = await log("gone.md");
    await send("DELETE", "/api/vaults/demo/files/gone.md", undefined, aitchn);
    await commit();
    expect((await log())[0]).toMatchObject({ subject: "Delete gone.md" });
    await post("/api/vaults/demo/restore", { path: "gone.md", commit: added!.id });
    expect(await readFile(path.join(vaultDir, "gone.md"), "utf8")).toBe("still here\n");
  });

  it("keeps empty folders and attributes folder moves and deletes", async () => {
    await post("/api/vaults/demo/folders", { path: "plans" }, aitchn);
    await commit();
    expect((await log())[0]).toMatchObject({
      subject: "Create folder plans",
      files: ["plans/.gitkeep"],
      author: { name: "Aitchn" },
    });

    await put("plans/a.md", "a\n", claude);
    await commit();
    await post("/api/vaults/demo/move", { from: "plans", to: "done/plans" }, aitchn);
    await commit();
    const [move] = await log();
    expect(move).toMatchObject({ subject: "Move plans to done/plans", author: { name: "Aitchn" } });
    expect([...move!.files].sort()).toEqual([
      "done/plans/.gitkeep",
      "done/plans/a.md",
      "plans/.gitkeep",
      "plans/a.md",
    ]);

    await send("DELETE", "/api/vaults/demo/files/done", undefined, aitchn);
    await commit();
    expect((await log())[0]).toMatchObject({ subject: "Delete done", author: { name: "Aitchn" } });
  });

  it("attributes a batch to the author and reason it came with", async () => {
    const res = await post(
      "/api/vaults/demo/batch",
      {
        writes: [
          { path: "x.md", baseVersion: null, content: "x\n" },
          { path: "y.md", baseVersion: null, content: "y\n" },
        ],
      },
      claude,
      "Import two notes",
    );
    expect(res.status).toBe(200);
    await commit();
    expect((await log())[0]).toMatchObject({
      subject: "Import two notes",
      author: { name: "Claude" },
      files: ["x.md", "y.md"],
    });
  });

  it("attributes the first edit in a vault that had no history yet", async () => {
    const imported = path.join(server.dataDir, "vaults", "imported");
    await mkdir(imported, { recursive: true });
    await writeFile(path.join(imported, "old.md"), "from before\n");
    await mkdir(path.join(imported, ".palimvo"));
    await writeFile(
      path.join(imported, ".palimvo", "config.json"),
      '{"schemaVersion":1,"createdAt":"2026-01-01T00:00:00.000Z"}',
    );
    const res = await send(
      "PUT",
      "/api/vaults/imported/files/new.md",
      { content: "new\n" },
      claude,
      "First edit",
    );
    expect(res.status).toBe(200);
    await server.services.history.commit("imported");
    const commits = (
      (await (await server.fetch("/api/vaults/imported/history")).json()) as {
        commits: CommitInfo[];
      }
    ).commits;
    expect(
      commits.map((c) => [c.subject, c.files.includes("old.md"), c.files.includes("new.md")]),
    ).toEqual([
      ["First edit", false, true],
      ["Create version history", true, false],
    ]);
    expect(commits[0]!.author.name).toBe("Claude");
  });

  it("makes tagged checkpoints that include changes still waiting for their commit", async () => {
    await put("n.md", "draft\n", claude);
    const res = await post(
      "/api/vaults/demo/checkpoints",
      { message: "First draft", tag: "v1" },
      aitchn,
    );
    expect(res.status).toBe(201);
    const made = (await res.json()) as CommitInfo;
    expect(made).toMatchObject({
      subject: "First draft",
      tags: ["v1"],
      files: ["n.md"],
      checkpoint: true,
      author: { name: "Aitchn" },
    });
    expect(made.coAuthors.map((a) => a.name)).toEqual(["Claude"]);
    const list = (await (await server.fetch("/api/vaults/demo/checkpoints")).json()) as {
      checkpoints: { name: string; commit: string; message: string }[];
    };
    expect(list.checkpoints).toEqual([
      expect.objectContaining({ name: "v1", commit: made.id, message: "First draft" }),
    ]);

    const before = (await log()).length;
    for (const tag of ["bad tag..", "-x", "v1"]) {
      const bad = await post("/api/vaults/demo/checkpoints", { message: "x", tag });
      expect(bad.status).toBe(tag === "v1" ? 409 : 400);
    }
    // Rejected tags leave no commit behind.
    expect((await log()).length).toBe(before);

    const untagged = await post("/api/vaults/demo/checkpoints", { message: "Nothing changed" });
    expect(untagged.status).toBe(201);
    expect(((await untagged.json()) as CommitInfo).files).toEqual([]);
  });

  it("commits more changed files than fit on one command line", async () => {
    // Windows caps a command line at 32K characters; Linux at a few MB. 12,000 long paths exceed both.
    const dir = path.join(vaultDir, "many");
    await mkdir(dir);
    const names = Array.from({ length: 12_000 }, (_, i) => `${"長".repeat(60)}-${i}.md`);
    for (const name of names) await writeFile(path.join(dir, name), "x");
    server.services.history.record(
      "demo",
      names.map((name) => `many/${name}`),
      claude,
      { reason: "Import many notes" },
    );
    const [made] = await commit();
    expect(made).toMatchObject({ subject: "Import many notes", author: { name: "Claude" } });
    expect(git("ls-files", "-z", "many").split("\0").filter(Boolean)).toHaveLength(12_000);
    expect(git("status", "--porcelain")).toBe("");
  }, 120_000);

  it("keeps files over the size limit out of the history", async () => {
    await server.dispose();
    server = await startTestServer({}, { history: { maxFileBytes: 1000 } });
    await post("/api/vaults", { id: "demo" });
    vaultDir = path.join(server.dataDir, "vaults", "demo");
    await writeFile(path.join(vaultDir, "huge.bin"), Buffer.alloc(2000, 1));
    await writeFile(path.join(vaultDir, "small.md"), "ok\n");
    await commit();
    expect(git("ls-files")).toContain("small.md");
    expect(git("ls-files")).not.toContain("huge.bin");
    // A tracked file that grows past the limit leaves the history, and stays on disk.
    await writeFile(path.join(vaultDir, "small.md"), "x".repeat(2000));
    await commit();
    expect(git("ls-files")).not.toContain("small.md");
    expect((await readFile(path.join(vaultDir, "small.md"), "utf8")).length).toBe(2000);
    expect((await log())[0]!.subject).toMatch(/^Stop versioning small\.md/);
  });

  it("commits external edits on its own, and again after a failed attempt", async () => {
    await server.dispose();
    server = await startTestServer({}, { history: { commitDelayMs: 30, commitMaxDelayMs: 100 } });
    await post("/api/vaults", { id: "demo" });
    vaultDir = path.join(server.dataDir, "vaults", "demo");
    const lock = path.join(vaultDir, ".git", "index.lock");
    await writeFile(lock, ""); // as if another git process were running
    await put("r.md", "x\n", claude);
    await new Promise((r) => setTimeout(r, 300));
    expect(await log("r.md")).toEqual([]);
    await rm(lock);
    await expect.poll(async () => (await log("r.md")).length, { timeout: 5000 }).toBe(1);
    expect((await log("r.md"))[0]!.author.name).toBe("Claude");

    await writeFile(path.join(vaultDir, "edited-elsewhere.md"), "hi\n");
    await server.services.vaults.readFile("demo", "r.md"); // starts watching the vault
    await new Promise((r) => setTimeout(r, 100));
    await writeFile(path.join(vaultDir, "edited-elsewhere-2.md"), "hi\n");
    await expect
      .poll(async () => (await log("edited-elsewhere-2.md")).length, { timeout: 15_000 })
      .toBe(1);
    expect((await log("edited-elsewhere-2.md"))[0]!.author.kind).toBe("external");
  });
});

describe("a vault from the previous product", () => {
  it("records the .aivault rename as a commit of its own", async () => {
    const old = path.join(server.dataDir, "vaults", "old");
    await mkdir(path.join(old, ".aivault", "plugins"), { recursive: true });
    await writeFile(path.join(old, ".aivault", "plugins", "p.json"), "{}");
    await writeFile(path.join(old, "note.md"), "hi\n");
    const run = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: old });
    run("init", "-q", "-b", "main");
    run("add", "-A");
    run("commit", "-q", "-m", "legacy history");

    expect((await server.fetch("/api/vaults/old/files")).status).toBe(200); // first use renames the folder
    await expect
      .poll(
        async () =>
          (
            (await (await server.fetch("/api/vaults/old/history")).json()) as {
              commits: CommitInfo[];
            }
          ).commits[0]?.subject,
        { timeout: 5000 },
      )
      .toBe("Rename .aivault to .palimvo");
    const commits = (
      (await (await server.fetch("/api/vaults/old/history")).json()) as { commits: CommitInfo[] }
    ).commits;
    expect(commits.map((c) => c.subject)).toEqual([
      "Rename .aivault to .palimvo",
      "legacy history",
    ]);
    expect(commits[0]!.files.sort()).toEqual([
      ".aivault/plugins/p.json",
      ".palimvo/plugins/p.json",
    ]);
  });
});

describe("removing a vault", () => {
  it("commits what was waiting first, so the removed folder holds the whole history", async () => {
    await put("last.md", "bye\n", aitchn);
    const removed = (await (await send("DELETE", "/api/vaults/demo")).json()) as { name: string };
    const trashed = path.join(server.dataDir, "trash", "vaults", removed.name);
    const subjects = execFileSync("git", ["log", "--format=%s"], { cwd: trashed }).toString();
    expect(subjects).toContain("Update last.md");
  });
});

describe("backup", () => {
  let remote: string;
  beforeEach(async () => {
    server = await (async () => {
      await server.dispose();
      return startTestServer({}, { backup: { allowLocalRemotes: true } });
    })();
    await post("/api/vaults", { id: "demo" });
    vaultDir = path.join(server.dataDir, "vaults", "demo");
    remote = path.join(await mkdtemp(path.join(tmpdir(), "palimvo-remote-")), "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  });
  afterEach(() => rm(path.dirname(remote), { recursive: true, force: true }));

  it("pushes history to the configured remote and keeps the setting in the vault config", async () => {
    await put("n.md", "backed up\n", aitchn);
    const res = await send(
      "PUT",
      "/api/vaults/demo/backup",
      { remote, intervalMinutes: 5 },
      aitchn,
    );
    const status = (await res.json()) as {
      lastPushAt: string | null;
      lastError: string | null;
      remote: string;
    };
    expect(status.lastError).toBeNull();
    expect(status.lastPushAt).not.toBeNull();
    expect(status.remote).toBe(remote);
    expect(execFileSync("git", ["--git-dir", remote, "show", "main:n.md"]).toString()).toBe(
      "backed up\n",
    );
    expect(
      JSON.parse(await readFile(path.join(vaultDir, ".palimvo", "config.json"), "utf8")),
    ).toMatchObject({
      backup: { remote, intervalMinutes: 5 },
    });

    // Tags travel too, and a later push sends only what is new.
    await post("/api/vaults/demo/checkpoints", { message: "Release", tag: "v1" }, aitchn);
    await post("/api/vaults/demo/backup/push", {});
    expect(execFileSync("git", ["--git-dir", remote, "tag", "-l"]).toString().trim()).toBe("v1");

    const off = (await (
      await send("PUT", "/api/vaults/demo/backup", { remote: null }, aitchn)
    ).json()) as {
      remote: string | null;
    };
    expect(off.remote).toBeNull();
    expect(execFileSync("git", ["remote"], { cwd: vaultDir }).toString()).toBe("");
  });

  it("pushes on its own once the interval has passed", async () => {
    await send("PUT", "/api/vaults/demo/backup", { remote, intervalMinutes: 1 });
    await put("later.md", "later\n", aitchn);
    await commit();
    const { backup } = server.services;
    await backup.pushDue(); // not due yet
    expect(() =>
      execFileSync("git", ["--git-dir", remote, "show", "main:later.md"], { stdio: "pipe" }),
    ).toThrow();
    const real = Date.now;
    Date.now = () => real() + 2 * 60_000;
    try {
      await backup.pushDue();
    } finally {
      Date.now = real;
    }
    expect(execFileSync("git", ["--git-dir", remote, "show", "main:later.md"]).toString()).toBe(
      "later\n",
    );
  });

  it("rejects addresses that could leak secrets or reach the server's own disk", async () => {
    const strict = await startTestServer();
    try {
      await strict.fetch("/api/vaults", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ id: "demo" }),
      });
      const set = (r: string) =>
        strict.fetch("/api/vaults/demo/backup", {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ remote: r }),
        });
      for (const bad of [
        "/tmp/anywhere",
        "file:///tmp/anywhere",
        "--upload-pack=evil",
        "https://user:secret-token@github.com/x/y.git",
        "https://secret-token@github.com/x/y.git",
        "ssh://git:pw@github.com/x/y.git",
        "https://exam ple.com/x.git",
      ]) {
        const res = await set(bad);
        expect(res.status, bad).toBe(400);
        expect(await res.json()).toMatchObject({ code: "invalid_backup_remote" });
      }
      // A remote that cannot be reached is accepted; the failure shows in the status, without secrets.
      const res = await set("https://127.0.0.1:1/x.git");
      expect(res.status).toBe(200);
      const status = (await res.json()) as { lastError: string | null };
      expect(status.lastError).toBeTruthy();
    } finally {
      await strict.dispose();
    }
  });
});
