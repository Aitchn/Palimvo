import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./index.ts";

let dir: string;
let clock: number;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "palimvo-store-"));
  clock = 1_000_000;
  store = await Store.openInDataDir(dir, { now: () => clock, checkpointIntervalMs: 0 });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const mkAccount = (username: string, serverAdmin = false) =>
  store.accounts.create({ username, passwordHash: "scrypt$x", serverAdmin });

describe("schema", () => {
  it("is at the latest version with all tables and a sound file", () => {
    expect(store.schemaVersion).toBe(4);
    expect(store.integrityProblems()).toEqual([]);
  });

  it("reopens an existing database without losing data", async () => {
    mkAccount("ann");
    store.close();
    store = await Store.openInDataDir(dir, { checkpointIntervalMs: 0 });
    expect(store.accounts.getByUsername("ANN")?.username).toBe("ann");
  });

  it("keeps node:sqlite imports inside store/db.ts only", async () => {
    const roots = [
      path.join(import.meta.dirname, ".."),
      path.join(import.meta.dirname, "../../test"),
    ];
    const offenders: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(ts|mjs)$/.test(e.name) && !p.endsWith(path.join("store", "db.ts"))) {
          const text = await readFile(p, "utf8");
          if (/from\s+["'](node:)?sqlite["']|require\(["'](node:)?sqlite["']\)/.test(text))
            offenders.push(p);
        }
      }
    };
    for (const r of roots) await walk(r);
    expect(offenders).toEqual([]);
  });
});

describe("accounts", () => {
  it("creates, finds case-insensitively, updates and lists", () => {
    const a = mkAccount("Ann", true);
    expect(a).toMatchObject({
      username: "Ann",
      displayName: "Ann",
      serverAdmin: true,
      disabled: false,
    });
    expect(store.accounts.getByUsername("ann")?.id).toBe(a.id);
    clock += 10;
    const b = store.accounts.update(a.id, { displayName: "Ann B" });
    expect(b.displayName).toBe("Ann B");
    expect(b.updatedAt).toBe(clock);
    expect(store.accounts.list().map((x) => x.username)).toEqual(["Ann"]);
    expect(store.accounts.count()).toBe(1);
  });

  it("rejects duplicate names with already_exists", () => {
    mkAccount("ann");
    expect(() => mkAccount("ANN")).toThrowError(
      expect.objectContaining({ code: "already_exists" }),
    );
  });

  it("never lets the last server administrator be removed, demoted or disabled", () => {
    const admin = mkAccount("root", true);
    expect(() => store.accounts.update(admin.id, { serverAdmin: false })).toThrowError(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => store.accounts.update(admin.id, { disabled: true })).toThrow();
    expect(() => store.accounts.delete(admin.id)).toThrow();
    const second = mkAccount("two", true);
    expect(store.accounts.update(admin.id, { serverAdmin: false }).serverAdmin).toBe(false);
    expect(() => store.accounts.delete(second.id)).toThrow();
  });

  it("cascades deletes to sessions, tokens, roles, memberships and overrides", () => {
    mkAccount("root", true);
    const u = mkAccount("user");
    const role = store.roles.create({ name: "R", position: 1 });
    store.roles.assign(role.id, u.id);
    store.accounts.setMember("v1", u.id, "member");
    store.sessions.create({ id: "s1", accountId: u.id, expiresAt: clock + 1000 });
    store.tokens.create({ accountId: u.id, name: "t", tokenHash: "h", access: "read" });
    store.roles.setOverride(
      { scope: "vault", vaultId: "v1", subjectType: "account", subjectId: u.id },
      { allow: 1, deny: 0 },
    );
    store.accounts.delete(u.id);
    expect(store.sessions.get("s1")).toBeUndefined();
    expect(store.tokens.listForAccount(u.id)).toEqual([]);
    expect(store.roles.memberIds(role.id)).toEqual([]);
    expect(store.accounts.listMembers("v1")).toEqual([]);
    expect(store.roles.vaultOverrides("v1")).toEqual([]);
  });

  it("tracks vault membership and forgets a removed vault", () => {
    const u = mkAccount("user");
    store.accounts.setMember("v1", u.id, "member");
    store.accounts.setMember("v2", u.id, "admin");
    expect(store.accounts.setMember("v1", u.id, "admin").position).toBe("admin");
    expect(store.accounts.listMemberships(u.id).map((m) => m.vaultId)).toEqual(["v1", "v2"]);
    store.tokens.create({
      accountId: u.id,
      name: "t",
      tokenHash: "h",
      access: "write",
      vaultId: "v1",
    });
    store.accounts.deleteVaultData("v1");
    expect(store.accounts.getMember("v1", u.id)).toBeUndefined();
    expect(store.tokens.listForAccount(u.id)).toEqual([]);
    expect(store.accounts.removeMember("v2", u.id)).toBe(true);
    expect(store.accounts.removeMember("v2", u.id)).toBe(false);
  });
});

describe("sessions", () => {
  it("expires, slides, and is removed with its account's other sessions", () => {
    const u = mkAccount("user");
    store.sessions.create({ id: "a", accountId: u.id, expiresAt: clock + 100, userAgent: "UA" });
    store.sessions.create({ id: "b", accountId: u.id, expiresAt: clock + 100 });
    expect(store.sessions.getValid("a")).toMatchObject({ userAgent: "UA" });
    clock += 50;
    store.sessions.touch("a", clock + 1000);
    clock += 100;
    expect(store.sessions.getValid("a")).toBeDefined();
    expect(store.sessions.getValid("b")).toBeUndefined();
    expect(store.sessions.purgeExpired()).toBe(1);
    store.sessions.create({ id: "c", accountId: u.id, expiresAt: clock + 100 });
    expect(store.sessions.deleteForAccount(u.id, "a")).toBe(1);
    expect(store.sessions.listForAccount(u.id).map((s) => s.id)).toEqual(["a"]);
    store.sessions.delete("a");
    expect(store.sessions.get("a")).toBeUndefined();
  });
});

describe("roles and overrides", () => {
  it("keeps one @everyone role that cannot be deleted, and orders by position", () => {
    const everyone = store.roles.create({ name: "@everyone", position: 0, isEveryone: true });
    expect(() => store.roles.create({ name: "@other", position: 0, isEveryone: true })).toThrow();
    const high = store.roles.create({
      name: "Designers",
      position: 5,
      color: "#f00",
      permissions: 6,
    });
    expect(store.roles.getEveryone()?.id).toBe(everyone.id);
    expect(store.roles.list().map((r) => r.name)).toEqual(["Designers", "@everyone"]);
    expect(() => store.roles.delete(everyone.id)).toThrowError(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => store.roles.create({ name: "designers", position: 1 })).toThrowError(
      expect.objectContaining({ code: "already_exists" }),
    );
    expect(store.roles.update(high.id, { color: null, position: 2 })).toMatchObject({
      position: 2,
    });
    expect(store.roles.get(high.id)?.color).toBeUndefined();
    expect(() => store.roles.update(high.id, { name: "@everyone" })).toThrow();
  });

  it("assigns roles to accounts, highest first, and cleans up on delete", () => {
    const u = mkAccount("user");
    const a = store.roles.create({ name: "A", position: 1 });
    const b = store.roles.create({ name: "B", position: 9 });
    store.roles.assign(a.id, u.id);
    store.roles.assign(b.id, u.id);
    store.roles.assign(b.id, u.id); // idempotent
    expect(store.roles.rolesOf(u.id).map((r) => r.name)).toEqual(["B", "A"]);
    expect(store.roles.unassign(a.id, u.id)).toBe(true);
    expect(() => store.roles.assign("missing", u.id)).toThrow();
    store.roles.delete(b.id);
    expect(store.roles.rolesOf(u.id)).toEqual([]);
  });

  it("upserts overrides per scope and subject, and lists a vault root-first", () => {
    const role = store.roles.create({ name: "R", position: 1 });
    const subject = { subjectType: "role" as const, subjectId: role.id };
    store.roles.setOverride({ scope: "server", ...subject }, { allow: 1, deny: 0 });
    store.roles.setOverride({ scope: "vault", vaultId: "v", ...subject }, { allow: 2, deny: 4 });
    store.roles.setOverride(
      { scope: "folder", vaultId: "v", folder: "a/b", ...subject },
      { allow: 0, deny: 8 },
    );
    store.roles.setOverride(
      { scope: "folder", vaultId: "v", folder: "a", ...subject },
      { allow: 0, deny: 16 },
    );
    const again = store.roles.setOverride(
      { scope: "vault", vaultId: "v", ...subject },
      { allow: 3, deny: 0 },
    );
    expect(again).toMatchObject({ allow: 3, deny: 0 });
    expect(store.roles.serverOverrides()).toHaveLength(1);
    expect(store.roles.vaultOverrides("v").map((o) => `${o.scope}:${o.folder ?? ""}`)).toEqual([
      "vault:",
      "folder:a",
      "folder:a/b",
    ]);
    expect(
      store.roles.getOverride({ scope: "folder", vaultId: "v", folder: "a", ...subject })?.deny,
    ).toBe(16);
    expect(
      store.roles.deleteOverride({ scope: "folder", vaultId: "v", folder: "a", ...subject }),
    ).toBe(true);
    expect(
      store.roles.deleteOverride({ scope: "folder", vaultId: "v", folder: "a", ...subject }),
    ).toBe(false);
  });

  it("rejects overrides that lack their target and removes them with the role", () => {
    const role = store.roles.create({ name: "R", position: 1 });
    const subject = { subjectType: "role" as const, subjectId: role.id };
    expect(() =>
      store.roles.setOverride({ scope: "vault", ...subject }, { allow: 0, deny: 0 }),
    ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(() =>
      store.roles.setOverride({ scope: "folder", vaultId: "v", ...subject }, { allow: 0, deny: 0 }),
    ).toThrow();
    store.roles.setOverride({ scope: "vault", vaultId: "v", ...subject }, { allow: 1, deny: 0 });
    store.roles.delete(role.id);
    expect(store.roles.vaultOverrides("v")).toEqual([]);
  });
});

describe("api tokens", () => {
  it("finds active tokens by hash and hides revoked or expired ones", () => {
    const u = mkAccount("user");
    const t = store.tokens.create({
      accountId: u.id,
      name: "Claude Code",
      tokenHash: "h1",
      access: "propose",
      vaultId: "v1",
      folders: ["design"],
      rateLimitPerMinute: 60,
      expiresAt: clock + 100,
    });
    expect(t).toMatchObject({ folders: ["design"], vaultId: "v1", rateLimitPerMinute: 60 });
    expect(store.tokens.getActiveByHash("h1")?.id).toBe(t.id);
    clock += 10;
    store.tokens.markUsed(t.id);
    expect(store.tokens.require(t.id).lastUsedAt).toBe(clock);
    clock += 200;
    expect(store.tokens.getActiveByHash("h1")).toBeUndefined();
    const t2 = store.tokens.create({ accountId: u.id, name: "b", tokenHash: "h2", access: "read" });
    expect(t2.vaultId).toBeUndefined();
    expect(store.tokens.revoke(t2.id)).toBe(true);
    expect(store.tokens.revoke(t2.id)).toBe(false);
    expect(store.tokens.getActiveByHash("h2")).toBeUndefined();
    expect(store.tokens.listForAccount(u.id)).toHaveLength(2);
    expect(store.tokens.delete(t.id)).toBe(true);
    expect(() => store.tokens.require(t.id)).toThrow();
    expect(() =>
      store.tokens.create({ accountId: u.id, name: "x", tokenHash: "h2", access: "read" }),
    ).toThrow();
  });
});

describe("oauth", () => {
  it("runs a code → access → refresh lifecycle", () => {
    const u = mkAccount("user");
    const client = store.oauth.registerClient({
      clientName: "Claude",
      redirectUris: ["https://x/cb"],
    });
    expect(store.oauth.getClient(client.clientId)?.redirectUris).toEqual(["https://x/cb"]);
    const grant = store.oauth.createGrant({
      clientId: client.clientId,
      accountId: u.id,
      scope: "mcp",
    });
    const code = store.oauth.issueToken({
      grantId: grant.id,
      kind: "code",
      tokenHash: "code1",
      expiresAt: clock + 60,
      codeChallenge: "abc",
      redirectUri: "https://x/cb",
    });
    expect(store.oauth.getUsableToken("code", "code1")).toMatchObject({ codeChallenge: "abc" });
    expect(store.oauth.getUsableToken("access", "code1")).toBeUndefined();
    expect(store.oauth.markUsed(code.id)).toBe(true);
    expect(store.oauth.markUsed(code.id)).toBe(false);
    expect(store.oauth.getUsableToken("code", "code1")).toBeUndefined();

    store.oauth.issueToken({
      grantId: grant.id,
      kind: "access",
      tokenHash: "acc",
      expiresAt: clock + 3600,
    });
    store.oauth.issueToken({
      grantId: grant.id,
      kind: "refresh",
      tokenHash: "ref",
      expiresAt: clock + 9999,
    });
    expect(store.oauth.getUsableToken("access", "acc")).toBeDefined();
    expect(store.oauth.listGrantsForAccount(u.id)).toHaveLength(1);
    expect(store.oauth.revokeGrant(grant.id)).toBe(true);
    expect(store.oauth.revokeGrant(grant.id)).toBe(false);
    expect(store.oauth.getUsableToken("access", "acc")).toBeUndefined();
    expect(store.oauth.getUsableToken("refresh", "ref")).toBeUndefined();
    expect(store.oauth.requireGrant(grant.id).revokedAt).toBe(clock);
    clock += 100_000;
    expect(store.oauth.purgeExpired()).toBe(3);
  });

  it("deleting a client removes its grants and tokens", () => {
    const u = mkAccount("user");
    const client = store.oauth.registerClient({ clientName: "C", redirectUris: [] });
    const grant = store.oauth.createGrant({ clientId: client.clientId, accountId: u.id });
    store.oauth.issueToken({
      grantId: grant.id,
      kind: "access",
      tokenHash: "a",
      expiresAt: clock + 10,
    });
    store.tx(() => store.accounts.delete(u.id));
    expect(store.oauth.getGrant(grant.id)).toBeUndefined();
  });
});

describe("audit log", () => {
  it("appends, filters, pages and prunes, and rejects unknown actor types", () => {
    store.audit.append({
      actorType: "account",
      actorId: "u1",
      action: "login",
      detail: { ok: true },
    });
    clock += 10;
    store.audit.append({
      actorType: "token",
      actorId: "t1",
      actorLabel: "Claude",
      action: "note.write",
      vaultId: "v1",
      targetType: "note",
      targetId: "a.md",
    });
    clock += 10;
    store.audit.append({ actorType: "system", action: "backup", ip: "127.0.0.1" });
    const all = store.audit.query();
    expect(all.map((e) => e.action)).toEqual(["backup", "note.write", "login"]);
    expect(all[2]?.detail).toEqual({ ok: true });
    expect(store.audit.query({ vaultId: "v1" })).toHaveLength(1);
    expect(store.audit.query({ actorId: "u1" })[0]?.action).toBe("login");
    expect(store.audit.query({ action: "backup" })[0]?.ip).toBe("127.0.0.1");
    expect(store.audit.query({ before: clock, limit: 1 })[0]?.action).toBe("note.write");
    expect(() =>
      store.tx(() => store.audit.append({ actorType: "bogus" as never, action: "x" })),
    ).toThrow();
    expect(store.audit.prune(clock - 5)).toBe(2);
    expect(store.audit.query()).toHaveLength(1);
  });
});

describe("server settings", () => {
  it("stores JSON values by key", () => {
    expect(store.settings.get("site.name")).toBeUndefined();
    store.settings.set("site.name", "Notes");
    store.settings.set("limits", { upload: 64, tags: ["a"] });
    store.settings.set("site.name", "Team notes");
    expect(store.settings.get<string>("site.name")).toBe("Team notes");
    expect(store.settings.all()).toEqual({
      limits: { upload: 64, tags: ["a"] },
      "site.name": "Team notes",
    });
    expect(store.settings.delete("limits")).toBe(true);
    expect(store.settings.delete("limits")).toBe(false);
  });
});

describe("plugin library index", () => {
  it("keeps immutable versions", () => {
    const u = mkAccount("user");
    const base = { id: "kanban", name: "Kanban", manifest: { id: "kanban" }, sha256: "aa" };
    store.library.add({ ...base, version: "1.0.0", builtin: true });
    clock += 5;
    store.library.add({ ...base, version: "1.1.0", sha256: "bb", uploadedBy: u.id });
    expect(() => store.library.add({ ...base, version: "1.0.0" })).toThrowError(
      expect.objectContaining({ code: "already_exists" }),
    );
    expect(store.library.get("kanban", "1.1.0")).toMatchObject({
      builtin: false,
      uploadedBy: u.id,
    });
    expect(store.library.versionsOf("kanban").map((p) => p.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(store.library.list()).toHaveLength(2);
    store.accounts.update(u.id, { displayName: "x" });
    expect(store.library.remove("kanban", "1.0.0")).toBe(1);
    expect(store.library.remove("kanban")).toBe(1);
  });
});

describe("transactions across repositories", () => {
  it("rolls everything back together", () => {
    expect(() =>
      store.tx(() => {
        mkAccount("temp");
        store.settings.set("k", 1);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.accounts.count()).toBe(0);
    expect(store.settings.get("k")).toBeUndefined();
  });
});

describe("backup", () => {
  it("produces a verified copy that opens with the same data", async () => {
    mkAccount("ann");
    const result = await store.backup(path.join(dir, "backups", "palimvo-backup.db"));
    expect(result.bytes).toBeGreaterThan(0);
    const copy = await Store.open({ file: result.file, checkpointIntervalMs: 0 });
    expect(copy.accounts.getByUsername("ann")).toBeDefined();
    copy.close();
  });
});

describe("upload links", () => {
  const link = (tokenHash: string, expiresAt: number) => ({
    tokenHash,
    vaultId: "v",
    path: "a/b.mp4",
    createOnly: true,
    author: { kind: "ai" as const, id: "claude", name: "Claude" },
    reason: "demo",
    expiresAt,
  });

  it("keeps a link until it expires or is used up", () => {
    store.uploadLinks.create(link("h1", clock + 1000));
    store.uploadLinks.create(link("h2", clock + 5000));
    expect(store.uploadLinks.get("h1")).toMatchObject({
      vaultId: "v",
      path: "a/b.mp4",
      createOnly: true,
      reason: "demo",
      author: { name: "Claude" },
    });
    expect(store.uploadLinks.countForVault("v")).toBe(2);
    store.uploadLinks.setUpload("h1", "abc");
    expect(store.uploadLinks.get("h1")?.uploadId).toBe("abc");

    clock += 2000;
    expect(store.uploadLinks.get("h1")).toBeUndefined();
    expect(store.uploadLinks.countForVault("v")).toBe(1);
    store.uploadLinks.delete("h2");
    expect(store.uploadLinks.get("h2")).toBeUndefined();
  });
});
