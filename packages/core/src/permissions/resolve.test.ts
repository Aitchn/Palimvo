import { describe, expect, it } from "vitest";
import { ALL_MASK, MEMBER_PERMISSIONS, VAULT_MASK, maskOf, namesOf } from "./catalog.ts";
import {
  fileScope,
  folderScope,
  resolvePermissions,
  resolveServerPermissions,
  serverScope,
  vaultScope,
  type PermissionData,
  type PermissionOverride,
  type PermissionRole,
  type PermissionSubject,
  type VaultMembership,
} from "./resolve.ts";

const everyone: PermissionRole = { id: "everyone", position: 0, permissions: 0, isEveryone: true };
const creator: PermissionRole = {
  id: "creator",
  position: 10,
  permissions: maskOf(["vaults.create"]),
};
const reader: PermissionRole = { id: "reader", position: 5, permissions: 0 };
const writer: PermissionRole = { id: "writer", position: 6, permissions: 0 };

function user(
  id: string,
  opts: { admin?: boolean; roles?: string[]; vaults?: Record<string, VaultMembership> } = {},
): PermissionSubject {
  return {
    id,
    serverAdmin: opts.admin ?? false,
    roleIds: opts.roles ?? [],
    vaults: new Map(Object.entries(opts.vaults ?? {})),
  };
}

const ov = (o: Partial<PermissionOverride> & Pick<PermissionOverride, "scope" | "subjectId">) =>
  ({ subjectType: "role", allow: 0, deny: 0, ...o }) as PermissionOverride;

function data(
  overrides: PermissionOverride[] = [],
  roles: PermissionRole[] = [everyone, creator, reader, writer],
  publicPermissions?: Map<string, number>,
): PermissionData {
  return { roles, overrides, ...(publicPermissions ? { publicPermissions } : {}) };
}

const names = (mask: number) => namesOf(mask & VAULT_MASK);
const can = (mask: number, ...n: Parameters<typeof maskOf>[0]) => (mask & maskOf(n)) === maskOf(n);

describe("server administrators", () => {
  it("hold everything in every scope, whatever the overrides say", () => {
    const admin = user("a", { admin: true });
    const d = data([
      ov({ scope: "vault", vaultId: "v", subjectId: "everyone", deny: ALL_MASK }),
      ov({ scope: "vault", vaultId: "v", subjectType: "account", subjectId: "a", deny: ALL_MASK }),
    ]);
    expect(resolvePermissions(admin, serverScope, d)).toBe(ALL_MASK);
    expect(resolvePermissions(admin, vaultScope("v"), d)).toBe(ALL_MASK);
    expect(resolvePermissions(admin, folderScope("v", "x/y"), d)).toBe(ALL_MASK);
  });
});

describe("server level", () => {
  it("is the union of the permissions of all roles plus the everyone role", () => {
    const d = data(
      [],
      [
        { ...everyone, permissions: maskOf(["assistant.use"]) },
        creator,
        { id: "mod", position: 3, permissions: maskOf(["users.manage"]) },
      ],
    );
    const mask = resolveServerPermissions(user("u", { roles: ["creator", "mod"] }), d);
    expect(namesOf(mask)).toEqual(["users.manage", "vaults.create", "assistant.use"]);
    // A role the person does not have contributes nothing.
    expect(namesOf(resolveServerPermissions(user("u"), d))).toEqual(["assistant.use"]);
  });

  it("ignores vault-level bits stored on a role", () => {
    const sneaky = { id: "s", position: 1, permissions: maskOf(["note.write", "audit.view"]) };
    const mask = resolveServerPermissions(
      user("u", { roles: ["s"] }),
      data([], [everyone, sneaky]),
    );
    expect(namesOf(mask)).toEqual(["audit.view"]);
  });

  it("gives nothing to a guest and ignores unknown roles", () => {
    expect(resolveServerPermissions(null, data())).toBe(0);
    expect(resolveServerPermissions(user("u", { roles: ["gone"] }), data())).toBe(0);
  });

  it("applies server overrides: role deny, role allow, person deny, person allow", () => {
    const u = user("u", { roles: ["creator"] });
    const base = data([
      ov({ scope: "server", subjectId: "creator", deny: maskOf(["vaults.create"]) }),
    ]);
    expect(can(resolveServerPermissions(u, base), "vaults.create")).toBe(false);

    const personal = data([
      ov({ scope: "server", subjectId: "creator", deny: maskOf(["vaults.create"]) }),
      ov({
        scope: "server",
        subjectType: "account",
        subjectId: "u",
        allow: maskOf(["vaults.create"]),
      }),
    ]);
    expect(can(resolveServerPermissions(u, personal), "vaults.create")).toBe(true);

    const grant = data([
      ov({
        scope: "server",
        subjectType: "account",
        subjectId: "u",
        allow: maskOf(["audit.view"]),
      }),
    ]);
    expect(can(resolveServerPermissions(user("u"), grant), "audit.view")).toBe(true);
    expect(can(resolveServerPermissions(user("other"), grant), "audit.view")).toBe(false);
  });

  it("keeps vault bits out of server overrides", () => {
    const d = data([ov({ scope: "server", subjectId: "everyone", allow: maskOf(["note.write"]) })]);
    expect(resolveServerPermissions(user("u"), d)).toBe(0);
  });

  it("is included in every scope", () => {
    const u = user("u", { roles: ["creator"], vaults: { v: "member" } });
    for (const scope of [
      serverScope,
      vaultScope("v"),
      folderScope("v", "a"),
      vaultScope("other"),
    ]) {
      expect(can(resolvePermissions(u, scope, data()), "vaults.create")).toBe(true);
    }
  });
});

describe("vault level", () => {
  it("gives people who have not joined only what the vault shows the public", () => {
    const pub = new Map([["v", maskOf(["vault.view", "note.read", "server.manage"])]]);
    const d = data([], undefined, pub);
    const outsider = user("u", { roles: ["creator"] });
    expect(names(resolvePermissions(outsider, vaultScope("v"), d))).toEqual([
      "vault.view",
      "note.read",
    ]);
    expect(names(resolvePermissions(null, vaultScope("v"), d))).toEqual([
      "vault.view",
      "note.read",
    ]);
    expect(names(resolvePermissions(null, vaultScope("w"), d))).toEqual([]);
    expect(names(resolvePermissions(outsider, vaultScope("w"), d))).toEqual([]);
  });

  it("does not let overrides lift a non-member above the public view", () => {
    const d = data([
      ov({ scope: "vault", vaultId: "v", subjectId: "everyone", allow: maskOf(["note.write"]) }),
      ov({
        scope: "folder",
        vaultId: "v",
        folder: "a",
        subjectId: "everyone",
        allow: maskOf(["note.write"]),
      }),
    ]);
    expect(names(resolvePermissions(user("u"), folderScope("v", "a"), d))).toEqual([]);
  });

  it("gives members the member set and vault admins every vault permission", () => {
    const member = user("m", { vaults: { v: "member" } });
    const admin = user("a", { vaults: { v: "admin" } });
    expect(resolvePermissions(member, vaultScope("v"), data())).toBe(MEMBER_PERMISSIONS);
    expect(resolvePermissions(admin, vaultScope("v"), data())).toBe(VAULT_MASK);
    // Membership of one vault says nothing about another.
    expect(resolvePermissions(admin, vaultScope("w"), data())).toBe(0);
  });

  it("lets a role deny beat the member set (Reader)", () => {
    const d = data([
      ov({
        scope: "vault",
        vaultId: "v",
        subjectId: "reader",
        deny: maskOf(["note.write", "note.delete", "file.upload"]),
      }),
    ]);
    const r = user("r", { roles: ["reader"], vaults: { v: "member" } });
    const mask = resolvePermissions(r, vaultScope("v"), d);
    expect(names(mask)).toEqual([
      "vault.view",
      "note.read",
      "history.view",
      "proposal.create",
      "mcp.connect",
    ]);
    // The same override does not touch a member without the role, or the same role elsewhere.
    expect(resolvePermissions(user("m", { vaults: { v: "member" } }), vaultScope("v"), d)).toBe(
      MEMBER_PERMISSIONS,
    );
    expect(
      resolvePermissions(
        user("r", { roles: ["reader"], vaults: { w: "member" } }),
        vaultScope("w"),
        d,
      ),
    ).toBe(MEMBER_PERMISSIONS);
  });

  it("lets a role allow add permissions the member set lacks", () => {
    const d = data([
      ov({ scope: "vault", vaultId: "v", subjectId: "writer", allow: maskOf(["history.restore"]) }),
    ]);
    const w = user("w", { roles: ["writer"], vaults: { v: "member" } });
    expect(can(resolvePermissions(w, vaultScope("v"), d), "history.restore")).toBe(true);
  });

  it("applies the everyone role's overrides to everybody who joined", () => {
    const d = data([
      ov({ scope: "vault", vaultId: "v", subjectId: "everyone", deny: maskOf(["mcp.connect"]) }),
    ]);
    expect(
      can(
        resolvePermissions(user("m", { vaults: { v: "member" } }), vaultScope("v"), d),
        "mcp.connect",
      ),
    ).toBe(false);
  });

  it("applies every deny of every role before every allow (allow of another role wins)", () => {
    const d = data([
      ov({ scope: "vault", vaultId: "v", subjectId: "reader", deny: maskOf(["note.write"]) }),
      ov({ scope: "vault", vaultId: "v", subjectId: "writer", allow: maskOf(["note.write"]) }),
    ]);
    const both = user("u", { roles: ["reader", "writer"], vaults: { v: "member" } });
    expect(can(resolvePermissions(both, vaultScope("v"), d), "note.write")).toBe(true);
    const onlyReader = user("u", { roles: ["reader"], vaults: { v: "member" } });
    expect(can(resolvePermissions(onlyReader, vaultScope("v"), d), "note.write")).toBe(false);
  });

  it("lets a personal override beat roles, deny before allow", () => {
    const roleAllow = ov({
      scope: "vault",
      vaultId: "v",
      subjectId: "writer",
      allow: maskOf(["history.restore"]),
    });
    const personDeny = ov({
      scope: "vault",
      vaultId: "v",
      subjectType: "account",
      subjectId: "u",
      deny: maskOf(["history.restore", "note.write"]),
    });
    const personAllow = ov({
      scope: "vault",
      vaultId: "v",
      subjectType: "account",
      subjectId: "u",
      allow: maskOf(["note.write"]),
    });
    const u = user("u", { roles: ["writer"], vaults: { v: "member" } });
    const denied = resolvePermissions(u, vaultScope("v"), data([roleAllow, personDeny]));
    expect(can(denied, "history.restore")).toBe(false);
    expect(can(denied, "note.write")).toBe(false);
    // With a personal allow as well, the allow comes after the deny and wins.
    const restored = resolvePermissions(
      u,
      vaultScope("v"),
      data([roleAllow, personDeny, personAllow]),
    );
    expect(can(restored, "note.write")).toBe(true);
    expect(can(restored, "history.restore")).toBe(false);
  });

  it("ignores another person's override and an unrelated vault's override", () => {
    const d = data([
      ov({
        scope: "vault",
        vaultId: "v",
        subjectType: "account",
        subjectId: "someone",
        deny: maskOf(["note.write"]),
      }),
      ov({ scope: "vault", vaultId: "w", subjectId: "everyone", deny: maskOf(["note.write"]) }),
    ]);
    expect(resolvePermissions(user("u", { vaults: { v: "member" } }), vaultScope("v"), d)).toBe(
      MEMBER_PERMISSIONS,
    );
  });

  it("lets a deny win over an allow of the same permission in one row", () => {
    const d = data([
      ov({
        scope: "vault",
        vaultId: "v",
        subjectId: "everyone",
        allow: maskOf(["history.restore"]),
        deny: maskOf(["history.restore"]),
      }),
    ]);
    expect(
      can(
        resolvePermissions(user("u", { vaults: { v: "member" } }), vaultScope("v"), d),
        "history.restore",
      ),
    ).toBe(false);
  });

  it("never locks a vault administrator out of administering the vault", () => {
    const d = data([ov({ scope: "vault", vaultId: "v", subjectId: "everyone", deny: ALL_MASK })]);
    const mask = resolvePermissions(user("a", { vaults: { v: "admin" } }), vaultScope("v"), d);
    expect(names(mask)).toEqual([
      "vault.view",
      "vault.settings",
      "members.manage",
      "permissions.manage",
    ]);
    // Members get no such protection.
    expect(
      names(resolvePermissions(user("m", { vaults: { v: "member" } }), vaultScope("v"), d)),
    ).toEqual([]);
  });
});

describe("folder level", () => {
  const w = maskOf(["note.write"]);
  const folderOv = (folder: string, extra: Partial<PermissionOverride>) =>
    ov({ scope: "folder", vaultId: "v", folder, subjectId: "writer", ...extra });
  const u = user("u", { roles: ["writer"], vaults: { v: "member" } });
  const at = (folder: string, overrides: PermissionOverride[]) =>
    resolvePermissions(u, folderScope("v", folder), data(overrides));

  it("denies writing in a folder and everything under it, not elsewhere", () => {
    const o = [folderOv("locked", { deny: w })];
    expect(can(at("locked", o), "note.write")).toBe(false);
    expect(can(at("locked/deep/er", o), "note.write")).toBe(false);
    expect(can(at("", o), "note.write")).toBe(true);
    expect(can(at("lockedx", o), "note.write")).toBe(true);
    expect(can(at("other", o), "note.write")).toBe(true);
    // Reading is unaffected.
    expect(can(at("locked", o), "note.read")).toBe(true);
  });

  it("lets the nearest folder win", () => {
    const o = [
      folderOv("a", { deny: w }),
      folderOv("a/b", { allow: w }),
      folderOv("a/b/c", { deny: w }),
    ];
    expect(can(at("a", o), "note.write")).toBe(false);
    expect(can(at("a/b", o), "note.write")).toBe(true);
    expect(can(at("a/b/x", o), "note.write")).toBe(true);
    expect(can(at("a/b/c", o), "note.write")).toBe(false);
    expect(can(at("a/b/c/d", o), "note.write")).toBe(false);
  });

  it("allows writing in one folder only for a vault-wide read-only role", () => {
    const o = [
      ov({
        scope: "vault",
        vaultId: "v",
        subjectId: "writer",
        deny: maskOf(["note.write", "note.delete", "file.upload"]),
      }),
      folderOv("design", { allow: maskOf(["note.write", "file.upload"]) }),
    ];
    expect(can(at("design/mockups", o), "note.write", "file.upload")).toBe(true);
    expect(can(at("design", o), "note.delete")).toBe(false);
    expect(can(at("docs", o), "note.write")).toBe(false);
  });

  it("matches folder names without regard to case or Unicode form", () => {
    const o = [folderOv("Café", { deny: w })];
    expect(can(at("café".normalize("NFD"), o), "note.write")).toBe(false);
    expect(can(at("CAFÉ/x", o), "note.write")).toBe(false);
  });

  it("prefers a personal folder override over a role one at the same folder", () => {
    const o = [
      folderOv("a", { deny: w }),
      folderOv("a", { subjectType: "account", subjectId: "u", allow: w }),
      folderOv("b", { subjectType: "account", subjectId: "u", deny: w }),
      folderOv("b", { allow: w }),
    ];
    expect(can(at("a", o), "note.write")).toBe(true);
    expect(can(at("b", o), "note.write")).toBe(false);
  });

  it("only lets folders change write-type permissions", () => {
    const o = [
      folderOv("a", {
        deny: maskOf(["note.read", "vault.view"]),
        allow: maskOf(["history.restore", "vault.settings"]),
      }),
    ];
    const mask = at("a", o);
    expect(can(mask, "note.read", "vault.view")).toBe(true);
    expect(can(mask, "history.restore")).toBe(false);
    expect(can(mask, "vault.settings")).toBe(false);
  });

  it("applies folder overrides only for the right vault and to the right person", () => {
    const o = [
      ov({ scope: "folder", vaultId: "w", folder: "a", subjectId: "writer", deny: w }),
      ov({
        scope: "folder",
        vaultId: "v",
        folder: "a",
        subjectType: "account",
        subjectId: "nobody",
        deny: w,
      }),
    ];
    expect(can(at("a", o), "note.write")).toBe(true);
  });

  it("ignores a folder override without a folder, and the vault root as a folder", () => {
    const bad = {
      scope: "folder",
      vaultId: "v",
      subjectType: "role",
      subjectId: "writer",
      allow: 0,
      deny: w,
    } as PermissionOverride;
    expect(can(at("a", [bad]), "note.write")).toBe(true);
    expect(can(at("", [folderOv("", { deny: w })]), "note.write")).toBe(true);
  });

  it("treats a file by the folder that holds it", () => {
    expect(fileScope("v", "locked/note.md")).toEqual(folderScope("v", "locked"));
    expect(fileScope("v", "note.md")).toEqual(folderScope("v", ""));
    const o = [folderOv("locked", { deny: w })];
    expect(can(resolvePermissions(u, fileScope("v", "locked/n.md"), data(o)), "note.write")).toBe(
      false,
    );
  });

  it("keeps protected vault-admin permissions and does not lift a non-member", () => {
    const o = [folderOv("a", { deny: w })];
    const admin = user("a", { roles: ["writer"], vaults: { v: "admin" } });
    // Folder denies still apply to vault admins for write types ...
    expect(can(resolvePermissions(admin, folderScope("v", "a"), data(o)), "note.write")).toBe(
      false,
    );
    // ... but never take away their control of the vault.
    expect(
      can(resolvePermissions(admin, folderScope("v", "a"), data(o)), "permissions.manage"),
    ).toBe(true);
    const outsider = user("o", { roles: ["writer"] });
    expect(names(resolvePermissions(outsider, folderScope("v", "a"), data(o)))).toEqual([]);
  });
});
