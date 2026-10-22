import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAppError } from "@palimvo/core";
import { tempVaults } from "../vault/testing.ts";
import type { VaultService } from "../vault/service.ts";
import { MAX_OPEN_UPLOADS, UPLOAD_IDLE_MS, UploadSessions } from "./sessions.ts";

let vaults: VaultService;
let root: string;
let dispose: () => Promise<void>;
let clock: number;
let free: number;
let sessions: UploadSessions;

beforeEach(async () => {
  ({ vaults, root, dispose } = await tempVaults());
  await vaults.createVault("demo");
  clock = 1_000_000;
  free = Number.MAX_SAFE_INTEGER;
  sessions = new UploadSessions(vaults, { now: () => clock, freeBytes: async () => free });
});
afterEach(() => dispose());

const stream = (bytes: Buffer) => new Blob([new Uint8Array(bytes)]).stream();
const code = async (work: Promise<unknown>) => {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isAppError(err)) throw new Error(`expected an API error, got ${String(err)}`);
  return err.code;
};

describe("upload sessions", () => {
  it("assembles parts, survives a restart and moves the file into place", async () => {
    const begun = await sessions.begin("demo", "a/b.bin", 6, true);
    await sessions.part("demo", begun.id, 0, stream(Buffer.from("abc")));
    // A new object over the same folder knows how far the upload got.
    const reopened = new UploadSessions(vaults, { now: () => clock });
    expect((await reopened.status("demo", begun.id)).received).toBe(3);
    await reopened.part("demo", begun.id, 3, stream(Buffer.from("def")));

    const placed = await reopened.finish("demo", begun.id, (source, meta) =>
      vaults.placeUpload("demo", meta.path, source, { create: meta.create }),
    );
    expect(placed).toMatchObject({ path: "a/b.bin", size: 6 });
    expect(await readFile(path.join(root, "demo", "a", "b.bin"), "utf8")).toBe("abcdef");
    expect(await readdir(path.join(root, "demo", ".palimvo", "uploads"))).toEqual([]);
  });

  it("drops a part that breaks off and takes it again from the same offset", async () => {
    const begun = await sessions.begin("demo", "x.bin", 8, false);
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("1234"));
        controller.error(new Error("connection reset"));
      },
    });
    await expect(sessions.part("demo", begun.id, 0, broken)).rejects.toThrow("connection reset");
    expect((await sessions.status("demo", begun.id)).received).toBe(0);
    await sessions.part("demo", begun.id, 0, stream(Buffer.from("12345678")));
    expect((await sessions.status("demo", begun.id)).received).toBe(8);
  });

  it("rejects an empty part, a late offset and an early finish", async () => {
    const begun = await sessions.begin("demo", "x.bin", 4, false);
    expect(await code(sessions.part("demo", begun.id, 0, null))).toBe("invalid_request");
    expect(await code(sessions.part("demo", begun.id, 2, stream(Buffer.from("ab"))))).toBe(
      "upload_offset",
    );
    expect(await code(sessions.finish("demo", begun.id, async () => 1))).toBe("upload_incomplete");
  });

  it("forgets uploads nobody touched for a day", async () => {
    const stale = await sessions.begin("demo", "old.bin", 4, false);
    clock += UPLOAD_IDLE_MS + 1;
    expect(await code(sessions.status("demo", stale.id))).toBe("not_found");
    const fresh = await sessions.begin("demo", "new.bin", 4, false);
    clock += UPLOAD_IDLE_MS + 1;
    await sessions.begin("demo", "newer.bin", 4, false); // sweeps `fresh`
    expect(await code(sessions.status("demo", fresh.id))).toBe("not_found");
  });

  it("refuses when the disk would be left too full, or too many uploads are open", async () => {
    free = 100 * 1024 * 1024;
    expect(await code(sessions.begin("demo", "big.bin", 1024 * 1024 * 1024, false))).toBe(
      "storage_full",
    );
    free = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < MAX_OPEN_UPLOADS; i++) await sessions.begin("demo", `f${i}.bin`, 1, false);
    expect(await code(sessions.begin("demo", "one-more.bin", 1, false))).toBe("upload_limit");
    expect(await code(sessions.begin("demo", "neg.bin", -1, false))).toBe("invalid_request");
  });
});
