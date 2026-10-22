import { describe, expect, it } from "vitest";
import { KeyedMutex, SharedExclusiveMutex } from "./mutex.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("KeyedMutex", () => {
  it("runs tasks for one key in order, never overlapping", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    let active = 0;
    const task = (name: string) => async () => {
      active++;
      expect(active).toBe(1);
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
      active--;
      return name;
    };
    const results = await Promise.all([
      mutex.run("v", task("a")),
      mutex.run("v", task("b")),
      mutex.run("v", task("c")),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("keeps going after a task fails", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run("v", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(mutex.run("v", async () => "ok")).resolves.toBe("ok");
  });

  it("runs different keys in parallel and idle() waits for all", async () => {
    const mutex = new KeyedMutex();
    let done = 0;
    void mutex.run("a", async () => {
      await tick();
      done++;
    });
    void mutex.run("b", async () => {
      await tick();
      done++;
    });
    await mutex.idle();
    expect(done).toBe(2);
  });
});

describe("SharedExclusiveMutex", () => {
  it("runs shared tasks for different files together, one at a time per file", async () => {
    const mutex = new SharedExclusiveMutex();
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
    };
    await Promise.all([
      mutex.shared("v", "a", task("a1")),
      mutex.shared("v", "b", task("b")),
      mutex.shared("v", "a", task("a2")),
    ]);
    expect(log.slice(0, 2).sort()).toEqual(["start a1", "start b"]);
    expect(log.indexOf("start a2")).toBeGreaterThan(log.indexOf("end a1"));
  });

  it("runs an exclusive task alone, after the tasks queued before it and before the ones queued after", async () => {
    const mutex = new SharedExclusiveMutex();
    const log: string[] = [];
    let active = 0;
    const task =
      (name: string, alone = false, counted = true) =>
      async () => {
        if (counted) active++;
        if (alone) expect(active).toBe(1);
        log.push(`start ${name}`);
        await tick();
        log.push(`end ${name}`);
        if (counted) active--;
      };
    await Promise.all([
      mutex.shared("v", "a", task("a")),
      mutex.shared("v", "b", task("b")),
      mutex.exclusive("v", task("x", true)),
      mutex.shared("v", "c", task("c")),
      mutex.exclusive("w", task("other vault", false, false)),
    ]);
    expect(log.indexOf("start x")).toBeGreaterThan(
      Math.max(log.indexOf("end a"), log.indexOf("end b")),
    );
    expect(log.indexOf("start c")).toBeGreaterThan(log.indexOf("end x"));
    // Another key is not held up.
    expect(log.indexOf("start other vault")).toBeLessThan(log.indexOf("end x"));
  });

  it("keeps going after failures and reports when idle", async () => {
    const mutex = new SharedExclusiveMutex();
    await expect(
      mutex.exclusive("v", async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    await expect(
      mutex.shared("v", "a", async () => Promise.reject(new Error("bang"))),
    ).rejects.toThrow("bang");
    let done = false;
    void mutex.shared("v", "a", async () => {
      await tick();
      done = true;
    });
    await mutex.idle();
    expect(done).toBe(true);
  });
});
