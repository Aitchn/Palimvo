import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "palimvo-crash-"));
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const fixture = fileURLToPath(new URL("./crash-writer.fixture.ts", import.meta.url));

/** Starts the writer, lets it run for `ms` after its first write, and kills it without warning. */
async function killAfter(ms: number, target: string): Promise<void> {
  const child = spawn(process.execPath, [fixture, target], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`writer exited early (${code})`)));
    child.stdout.on("data", (d: Buffer) => d.toString().includes("ready") && resolve());
  });
  await new Promise((r) => setTimeout(r, ms));
  child.removeAllListeners("exit");
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await exited;
}

it("leaves the file whole when the process is killed in the middle of writes", async () => {
  const target = path.join(dir, "note.md");
  for (const ms of [0, 2, 5, 10, 20, 50, 100]) {
    await killAfter(ms, target);
    const text = await readFile(target, "utf8");
    const m = /^(\d+):x+:(\d+)$/.exec(text);
    expect(m, `a whole file after killing at +${ms}ms`).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    expect(text.length).toBe(256 * 1024 + m![1]!.length * 2 + 2);
  }
  // A killed write may leave a hidden temp file; it never replaces the real one.
  const leftovers = (await readdir(dir)).filter((n) => n !== "note.md");
  for (const name of leftovers) expect(name).toMatch(/^\.note\.md\.tmp-[0-9a-f]{8}$/);
}, 60_000);
