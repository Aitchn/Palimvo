import { formatAuthor, makeAuthor, maskOf, type Author } from "@palimvo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommitInfo } from "../src/history/history.ts";
import type { ProposalSummary, ProposalView } from "../src/proposals/proposals.ts";
import { Client, PASSWORD, json } from "./client.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
  expect((await send("POST", "/api/vaults", { id: "demo" })).status).toBe(201);
  await put("plan.md", "# Plan\n\nWe ship in March.\n\nOwner: Dana\n");
  await put("notes.md", "alpha\nbeta\ngamma\n");
});
afterEach(() => server.dispose());

const claude = makeAuthor("ai", "Claude");
const aitchn = makeAuthor("human", "Aitchn");

function send(method: string, path: string, body?: unknown, author?: Author) {
  return server.fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(author ? { "x-palimvo-author": formatAuthor(author) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const put = (file: string, content: string, author?: Author) =>
  send("PUT", `/api/vaults/demo/files/${file}`, { content }, author);
const read = async (file: string) =>
  json<{ content: string; version: string }>(await send("GET", `/api/vaults/demo/files/${file}`));
const base = "/api/vaults/demo/proposals";

async function propose(
  files: { path: string; hunks: { before: string; after: string; rationale?: string }[] }[],
  title = "Tidy the plan",
) {
  const withRevisions = [];
  for (const f of files) {
    const current = await send("GET", `/api/vaults/demo/files/${f.path}`);
    withRevisions.push({
      ...f,
      baseRevision:
        current.status === 200 ? (await json<{ version: string }>(current)).version : null,
    });
  }
  return send("POST", base, { title, rationale: "Because", files: withRevisions }, claude);
}
const created = async (...args: Parameters<typeof propose>) => {
  const res = await propose(...args);
  expect(res.status).toBe(201);
  return json<ProposalView>(res);
};
const review = (p: ProposalView, action: "accept" | "reject", hunkIds?: string[]) =>
  send("POST", `${base}/${p.id}/${action}`, { version: p.version, hunkIds }, aitchn);
const hunk = (p: ProposalView, file: string, i = 0) =>
  p.files.find((f) => f.path === file)!.hunks[i]!;

describe("edit proposals", () => {
  it("stores a proposal under the proposing AI without touching the note", async () => {
    const p = await created([
      { path: "plan.md", hunks: [{ before: "March", after: "April", rationale: "Slipped" }] },
    ]);
    expect(p).toMatchObject({
      title: "Tidy the plan",
      state: "pending",
      stale: false,
      proposedBy: { kind: "ai", name: "Claude" },
    });
    const h = hunk(p, "plan.md");
    expect(h).toMatchObject({
      before: "March",
      after: "April",
      state: "pending",
      rationale: "Slipped",
    });
    expect(h.contextBefore.endsWith("We ship in ")).toBe(true);
    expect((await read("plan.md")).content).toContain("March");

    const list = await json<{ proposals: ProposalSummary[] }>(await send("GET", base));
    expect(list.proposals).toHaveLength(1);
    expect(list.proposals[0]).toMatchObject({
      id: p.id,
      files: [{ path: "plan.md", pending: 1, accepted: 0, rejected: 0, status: "current" }],
    });
  });

  it("accepts some changes and credits the proposer, with the approver in the history", async () => {
    const p = await created([
      {
        path: "plan.md",
        hunks: [
          { before: "March", after: "April" },
          { before: "Dana", after: "Eli" },
        ],
      },
    ]);
    const [first, second] = p.files[0]!.hunks;
    const res = await review(p, "accept", [first!.id]);
    expect(res.status).toBe(200);
    const after = await json<ProposalView>(res);
    expect(after.state).toBe("partial");
    expect((await read("plan.md")).content).toBe("# Plan\n\nWe ship in April.\n\nOwner: Dana\n");
    expect(after.files[0]!.hunks.map((h) => h.state)).toEqual(["accepted", "pending"]);
    expect(after.files[0]!.status).toBe("current");

    // The hunk that was left moved with the text, so it still applies.
    const rest = await review(after, "accept", [second!.id]);
    expect(rest.status).toBe(200);
    expect(await json<ProposalView>(rest)).toMatchObject({ state: "accepted" });
    expect((await read("plan.md")).content).toBe("# Plan\n\nWe ship in April.\n\nOwner: Eli\n");

    await server.services.history.commit("demo");
    const { commits } = await json<{ commits: CommitInfo[] }>(
      await send("GET", "/api/vaults/demo/history?path=plan.md"),
    );
    expect(commits[0]).toMatchObject({
      author: { kind: "ai", name: "Claude" },
      reasons: ["Tidy the plan"],
      approvedBy: [{ kind: "human", name: "Aitchn" }],
    });
  });

  it("accepts and rejects across two files in a single step", async () => {
    const p = await created([
      { path: "plan.md", hunks: [{ before: "March", after: "April" }] },
      {
        path: "notes.md",
        hunks: [
          { before: "beta", after: "BETA" },
          { before: "gamma", after: "GAMMA" },
        ],
      },
      { path: "new.md", hunks: [{ before: "", after: "# New\n" }] },
    ]);
    expect(p.files.find((f) => f.path === "new.md")!.baseRevision).toBeNull();
    const accepted = [hunk(p, "plan.md"), hunk(p, "notes.md", 0), hunk(p, "new.md")].map(
      (h) => h.id,
    );
    const res = await review(p, "accept", accepted);
    expect(res.status).toBe(200);
    const mid = await json<ProposalView>(res);
    expect(mid.state).toBe("partial");
    expect((await read("plan.md")).content).toContain("April");
    expect((await read("notes.md")).content).toBe("alpha\nBETA\ngamma\n");
    expect((await read("new.md")).content).toBe("# New\n");

    const rejected = await review(mid, "reject", [hunk(mid, "notes.md", 1).id]);
    expect(await json<ProposalView>(rejected)).toMatchObject({ state: "resolved" });
    expect((await read("notes.md")).content).toBe("alpha\nBETA\ngamma\n");
    const open = await json<{ proposals: unknown[] }>(await send("GET", base));
    expect(open.proposals).toHaveLength(0);
    const all = await json<{ proposals: unknown[] }>(await send("GET", `${base}?state=all`));
    expect(all.proposals).toHaveLength(1);
  });

  it("accepts everything still waiting when no hunks are named", async () => {
    const p = await created([
      {
        path: "notes.md",
        hunks: [
          { before: "alpha", after: "A" },
          { before: "gamma", after: "G" },
        ],
      },
    ]);
    expect((await review(p, "accept")).status).toBe(200);
    expect((await read("notes.md")).content).toBe("A\nbeta\nG\n");
  });

  it("notices when a file changed after the proposal and refuses to apply it", async () => {
    const p = await created([
      { path: "plan.md", hunks: [{ before: "March", after: "April" }] },
      { path: "notes.md", hunks: [{ before: "beta", after: "BETA" }] },
    ]);
    await put("notes.md", "alpha\nbeta\ngamma\ndelta\n", aitchn);

    const view = await json<ProposalView>(await send("GET", `${base}/${p.id}`));
    expect(view.stale).toBe(true);
    expect(view.files.map((f) => [f.path, f.status])).toEqual([
      ["plan.md", "current"],
      ["notes.md", "stale"],
    ]);

    // Nothing is written, not even the file that still matches.
    const res = await review(view, "accept");
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("proposal_stale");
    expect((await read("plan.md")).content).toContain("March");

    // The change that still matches can go in alone; the stale one can only be rejected.
    expect((await review(view, "accept", [hunk(view, "plan.md").id])).status).toBe(200);
    const rejected = await review(
      await json<ProposalView>(await send("GET", `${base}/${p.id}`)),
      "reject",
    );
    expect(rejected.status).toBe(200);
    expect((await read("notes.md")).content).toBe("alpha\nbeta\ngamma\ndelta\n");
  });

  it("marks a proposal stale when its file was deleted", async () => {
    const p = await created([{ path: "notes.md", hunks: [{ before: "beta", after: "B" }] }]);
    await send("DELETE", "/api/vaults/demo/files/notes.md", undefined, aitchn);
    const view = await json<ProposalView>(await send("GET", `${base}/${p.id}`));
    expect(view.files[0]!.status).toBe("missing");
    expect((await review(view, "accept")).status).toBe(409);
  });

  it("refuses a decision made on an out-of-date view or on a hunk already decided", async () => {
    const p = await created([
      {
        path: "notes.md",
        hunks: [
          { before: "alpha", after: "A" },
          { before: "beta", after: "B" },
        ],
      },
    ]);
    const first = hunk(p, "notes.md", 0).id;
    expect((await review(p, "accept", [first])).status).toBe(200);
    // Same version again: someone else decided in between.
    const again = await review(p, "accept", [first]);
    expect(again.status).toBe(409);
    expect((await json<{ code: string }>(again)).code).toBe("proposal_changed");
    const fresh = await json<ProposalView>(await send("GET", `${base}/${p.id}`));
    expect((await review(fresh, "reject", [first])).status).toBe(409);
    expect((await review(fresh, "reject", ["00000000-0000-4000-8000-000000000000"])).status).toBe(
      409,
    );
  });

  it("rejects proposals that do not fit the file", async () => {
    const version = (await read("plan.md")).version;
    const post = (body: unknown) => send("POST", base, body, claude);
    const file = (hunks: unknown[], path = "plan.md", baseRevision: string | null = version) => ({
      title: "t",
      files: [{ path, baseRevision, hunks }],
    });
    const code = async (res: Response) => (await json<{ code: string }>(res)).code;

    // text that is not there, text that is there twice, nothing changed, overlapping changes
    expect(await code(await post(file([{ before: "April", after: "May" }])))).toBe(
      "invalid_request",
    );
    await put("twice.md", "x x");
    const twice = (await read("twice.md")).version;
    expect(await code(await post(file([{ before: "x", after: "y" }], "twice.md", twice)))).toBe(
      "invalid_request",
    );
    expect(await code(await post(file([{ before: "March", after: "March" }])))).toBe(
      "invalid_request",
    );
    expect(
      await code(
        await post(
          file([
            { before: "ship in", after: "a" },
            { before: "in March", after: "b" },
          ]),
        ),
      ),
    ).toBe("invalid_request");
    // offsets that disagree with the text
    expect(await code(await post(file([{ start: 0, end: 3, before: "March", after: "x" }])))).toBe(
      "invalid_request",
    );
    // a version the file no longer has, a file type that cannot be proposed, a bad body
    expect(
      await code(await post(file([{ before: "March", after: "May" }], "plan.md", "0".repeat(16)))),
    ).toBe("version_conflict");
    expect(await code(await post(file([{ before: "", after: "x" }], "pic.png", null)))).toBe(
      "unsupported_type",
    );
    expect(await code(await post({ title: "", files: [] }))).toBe("invalid_request");
    expect((await json<{ proposals: unknown[] }>(await send("GET", base))).proposals).toHaveLength(
      0,
    );
  });

  it("does not let a change leave a canvas unreadable", async () => {
    await put("board.canvas", JSON.stringify({ nodes: [], edges: [] }));
    const res = await propose([
      { path: "board.canvas", hunks: [{ before: '"nodes":[]', after: '"nodes":[' }] },
    ]);
    expect(res.status).toBe(400);
    expect((await json<{ details: { reason: string } }>(res)).details.reason).toMatch(/unreadable/);
  });

  it("finishes the bookkeeping of an accept that was interrupted after the file was written", async () => {
    const p = await created([
      {
        path: "notes.md",
        hunks: [
          { before: "alpha", after: "A" },
          { before: "gamma", after: "G" },
        ],
      },
    ]);
    const { vaults } = server.services;
    const raw = JSON.parse((await vaults.readMeta("demo", `proposals/${p.id}.json`))!);
    const next = "A\nbeta\ngamma\n";
    // As if the server stopped after the note was written but before the proposal was updated.
    const { createHash } = await import("node:crypto");
    raw.applying = {
      reviewer: aitchn,
      files: [
        {
          path: "notes.md",
          hunkIds: [raw.files[0].hunks[0].id],
          resultVersion: createHash("sha256").update(next).digest("hex").slice(0, 16),
        },
      ],
    };
    await vaults.writeMeta("demo", `proposals/${p.id}.json`, JSON.stringify(raw));
    await put("notes.md", next, aitchn);

    const view = await json<ProposalView>(await send("GET", `${base}/${p.id}`));
    expect(view.files[0]!.hunks.map((h) => h.state)).toEqual(["accepted", "pending"]);
    expect(view.state).toBe("partial");
    expect(view.stale).toBe(false);
    expect((await review(view, "accept")).status).toBe(200);
    expect((await read("notes.md")).content).toBe("A\nbeta\nG\n");
  });

  it("credits a recovered accept to the proposer and the approver", async () => {
    const p = await created([{ path: "notes.md", hunks: [{ before: "alpha", after: "A" }] }]);
    const { vaults } = server.services;
    const raw = JSON.parse((await vaults.readMeta("demo", `proposals/${p.id}.json`))!);
    const { createHash } = await import("node:crypto");
    const next = "A\nbeta\ngamma\n";
    raw.applying = {
      reviewer: makeAuthor("human", "Dana", { id: "dana-login" }),
      files: [
        {
          path: "notes.md",
          hunkIds: [raw.files[0].hunks[0].id],
          resultVersion: createHash("sha256").update(next).digest("hex").slice(0, 16),
        },
      ],
    };
    await vaults.writeMeta("demo", `proposals/${p.id}.json`, JSON.stringify(raw));
    // Written by the interrupted accept, whose attribution was lost with the process.
    await put("notes.md", next);
    await send("GET", `${base}/${p.id}`);
    await server.services.history.commit("demo");
    const { commits } = await json<{ commits: CommitInfo[] }>(
      await send("GET", "/api/vaults/demo/history?path=notes.md"),
    );
    expect(commits[0]).toMatchObject({
      author: { kind: "ai", name: "Claude" },
      reasons: ["Tidy the plan"],
      approvedBy: [{ kind: "human", name: "Dana", id: "dana-login" }],
    });
  });

  it("refuses changes that start at the same place", async () => {
    const version = (await read("notes.md")).version;
    const res = await send(
      "POST",
      base,
      {
        title: "t",
        files: [
          {
            path: "notes.md",
            baseRevision: version,
            hunks: [
              { start: 6, end: 6, before: "", after: "x" },
              { start: 6, end: 6, before: "", after: "y" },
            ],
          },
        ],
      },
      claude,
    );
    expect(res.status).toBe(400);
  });

  it("drops an interrupted accept whose file never got written", async () => {
    const p = await created([{ path: "notes.md", hunks: [{ before: "alpha", after: "A" }] }]);
    const { vaults } = server.services;
    const raw = JSON.parse((await vaults.readMeta("demo", `proposals/${p.id}.json`))!);
    raw.applying = {
      reviewer: aitchn,
      files: [
        { path: "notes.md", hunkIds: [raw.files[0].hunks[0].id], resultVersion: "f".repeat(16) },
      ],
    };
    await vaults.writeMeta("demo", `proposals/${p.id}.json`, JSON.stringify(raw));
    const view = await json<ProposalView>(await send("GET", `${base}/${p.id}`));
    expect(view.files[0]!.hunks[0]!.state).toBe("pending");
    expect(view.state).toBe("pending");
  });

  it("keeps proposals out of the version history", async () => {
    await created([{ path: "plan.md", hunks: [{ before: "March", after: "April" }] }]);
    await server.services.history.commit("demo");
    const { commits } = await json<{ commits: CommitInfo[] }>(
      await send("GET", "/api/vaults/demo/history"),
    );
    expect(commits.flatMap((c) => c.files).some((f) => f.includes("proposals/"))).toBe(false);
  });
});

describe("who may propose and decide", () => {
  async function signIn(name: string, serverAdmin = false) {
    const account = await server.auth.createAccount({
      username: name,
      password: PASSWORD,
      serverAdmin,
    });
    const client = new Client(server);
    expect((await client.login(name)).status).toBe(200);
    return { client, id: account.id };
  }

  async function accounts() {
    const root = await signIn("root", true);
    expect((await root.client.post("/api/vaults", { id: "v" })).status).toBe(201);
    expect(
      (await root.client.put("/api/vaults/v/files/a.md", { content: "one two three" })).status,
    ).toBe(200);
    const mia = await signIn("mia");
    server.store.joinVault("v", mia.id, "member");
    const outsider = await signIn("zed");
    const version = (
      await json<{ version: string }>(await root.client.get("/api/vaults/v/files/a.md"))
    ).version;
    return { root, mia, outsider, version };
  }

  const body = (version: string) => ({
    title: "Say it in digits",
    files: [{ path: "a.md", baseRevision: version, hunks: [{ before: "two", after: "2" }] }],
  });

  it("lets a member propose, but only someone with the review right decide", async () => {
    const { root, mia, version } = await accounts();
    const res = await mia.client.post("/api/vaults/v/proposals", body(version));
    expect(res.status).toBe(201);
    const p = await json<ProposalView>(res);
    expect(p.proposedBy).toMatchObject({ kind: "human", name: "mia" });

    // A member sees the proposal but cannot accept or reject it.
    expect((await mia.client.get(`/api/vaults/v/proposals/${p.id}`)).status).toBe(200);
    const denied = await mia.client.post(`/api/vaults/v/proposals/${p.id}/accept`, { version: 1 });
    expect(denied.status).toBe(403);
    expect(
      (await mia.client.post(`/api/vaults/v/proposals/${p.id}/reject`, { version: 1 })).status,
    ).toBe(403);
    expect((await root.client.get("/api/vaults/v/files/a.md")).status).toBe(200);
    expect(
      (await json<{ content: string }>(await root.client.get("/api/vaults/v/files/a.md"))).content,
    ).toBe("one two three");

    const ok = await root.client.post(`/api/vaults/v/proposals/${p.id}/accept`, { version: 1 });
    expect(ok.status).toBe(200);
    await server.services.history.commit("v");
    const { commits } = await json<{ commits: CommitInfo[] }>(
      await root.client.get("/api/vaults/v/history?path=a.md"),
    );
    expect(commits[0]).toMatchObject({
      author: { kind: "human", name: "mia" },
      approvedBy: [{ kind: "human", name: "root" }],
    });
  });

  it("respects a folder that takes the review right away", async () => {
    const { root, mia, version } = await accounts();
    expect(
      (await root.client.put("/api/vaults/v/files/locked/s.md", { content: "secret" })).status,
    ).toBe(200);
    const s = (
      await json<{ version: string }>(await root.client.get("/api/vaults/v/files/locked/s.md"))
    ).version;
    const subject = { subjectType: "account" as const, subjectId: mia.id };
    server.store.roles.setOverride(
      { scope: "vault", vaultId: "v", ...subject },
      { allow: maskOf(["proposal.review"]), deny: 0 },
    );
    server.store.roles.setOverride(
      { scope: "folder", vaultId: "v", folder: "locked", ...subject },
      { allow: 0, deny: maskOf(["proposal.review"]) },
    );
    const propose = async () =>
      json<ProposalView>(
        await mia.client.post("/api/vaults/v/proposals", {
          title: "Two files",
          files: [
            { path: "a.md", baseRevision: version, hunks: [{ before: "one", after: "1" }] },
            {
              path: "locked/s.md",
              baseRevision: s,
              hunks: [{ before: "secret", after: "public" }],
            },
          ],
        }),
      );
    const p = await propose();
    const [onA, onLocked] = [p.files[0]!.hunks[0]!.id, p.files[1]!.hunks[0]!.id];
    const decide = (action: string, hunkIds?: string[]) =>
      mia.client.post(`/api/vaults/v/proposals/${p.id}/${action}`, { version: 1, hunkIds });

    // Deciding on the locked folder's change, alone or together with another, is refused.
    expect((await decide("accept", [onLocked])).status).toBe(403);
    expect((await decide("accept")).status).toBe(403);
    expect((await decide("reject", [onLocked, onA])).status).toBe(403);
    expect(
      (await json<{ content: string }>(await root.client.get("/api/vaults/v/files/a.md"))).content,
    ).toBe("one two three");
    // The change outside it is hers to decide.
    expect((await decide("accept", [onA])).status).toBe(200);
    expect(
      (await json<{ content: string }>(await root.client.get("/api/vaults/v/files/a.md"))).content,
    ).toBe("1 two three");
  });

  it("hides proposals from people who are not in the vault", async () => {
    const { mia, outsider, version } = await accounts();
    const p = await json<ProposalView>(
      await mia.client.post("/api/vaults/v/proposals", body(version)),
    );
    expect([403, 404]).toContain((await outsider.client.get("/api/vaults/v/proposals")).status);
    expect([403, 404]).toContain(
      (await outsider.client.get(`/api/vaults/v/proposals/${p.id}`)).status,
    );
    expect([403, 404]).toContain(
      (await outsider.client.post("/api/vaults/v/proposals", body(version))).status,
    );
    const guest = new Client(server);
    expect((await guest.get("/api/vaults/v/proposals")).status).toBe(401);
  });
});
