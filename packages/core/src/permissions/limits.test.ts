import { describe, expect, it } from "vitest";
import { ALL_MASK, MEMBER_PERMISSIONS, VAULT_MASK, maskOf, namesOf } from "./catalog.ts";
import { TOKEN_ACCESS_PERMISSIONS, intersect } from "./limits.ts";
import { folderScope, serverScope, vaultScope } from "./resolve.ts";

describe("intersect", () => {
  it("returns the person's permissions when there is no limit", () => {
    expect(intersect(MEMBER_PERMISSIONS)).toBe(MEMBER_PERMISSIONS);
  });

  it("narrows by a plain mask (assistant policy, plugin permissions)", () => {
    const policy = maskOf(["note.read", "note.write", "history.restore"]);
    expect(namesOf(intersect(MEMBER_PERMISSIONS, policy))).toEqual(["note.read", "note.write"]);
    expect(intersect(MEMBER_PERMISSIONS, 0)).toBe(0);
  });

  it("applies several limits at once", () => {
    const a = maskOf(["note.read", "note.write"]);
    const b = maskOf(["note.read", "note.delete"]);
    expect(namesOf(intersect(ALL_MASK, a, b))).toEqual(["note.read"]);
  });

  it("limits tokens by access level and never adds permissions", () => {
    const token = (access: "read" | "write" | "propose") => ({
      token: { access, vaultId: "v" },
      scope: vaultScope("v"),
    });
    expect(namesOf(intersect(ALL_MASK, token("read")))).toEqual([
      "vault.view",
      "note.read",
      "history.view",
    ]);
    expect(namesOf(intersect(ALL_MASK, token("propose")))).toEqual([
      "vault.view",
      "note.read",
      "history.view",
      "proposal.create",
    ]);
    expect(namesOf(intersect(ALL_MASK, token("write")))).toEqual([
      "vault.view",
      "note.read",
      "note.write",
      "note.delete",
      "file.upload",
      "history.view",
      "proposal.create",
    ]);
    // A creator without write permission cannot hand a token the power to write.
    expect(namesOf(intersect(maskOf(["note.read"]), token("write")))).toEqual(["note.read"]);
    for (const mask of Object.values(TOKEN_ACCESS_PERMISSIONS)) expect(mask & ~VAULT_MASK).toBe(0);
  });

  it("gives a token nothing outside its vault or at server scope", () => {
    const t = { access: "write" as const, vaultId: "v" };
    expect(intersect(ALL_MASK, { token: t, scope: vaultScope("other") })).toBe(0);
    expect(intersect(ALL_MASK, { token: t, scope: serverScope })).toBe(0);
    const any = { access: "read" as const };
    expect(intersect(ALL_MASK, { token: any, scope: vaultScope("other") })).not.toBe(0);
  });

  it("gives an admin grant only vaults.create and library.publish, and only with write access", () => {
    const grant = (access: "read" | "write" | "propose", admin?: boolean) => ({
      token: { access, admin },
      scope: serverScope,
    });
    expect(namesOf(intersect(ALL_MASK, grant("write", true)))).toEqual([
      "vaults.create",
      "library.publish",
    ]);
    // Never more than the person holds.
    expect(namesOf(intersect(maskOf(["vaults.create"]), grant("write", true)))).toEqual([
      "vaults.create",
    ]);
    expect(intersect(ALL_MASK, grant("write"))).toBe(0);
    expect(intersect(ALL_MASK, grant("write", false))).toBe(0);
    expect(intersect(ALL_MASK, grant("read", true))).toBe(0);
    expect(intersect(ALL_MASK, grant("propose", true))).toBe(0);
    // The flag adds nothing inside vaults.
    const inVault = (admin: boolean) =>
      intersect(ALL_MASK, { token: { access: "write" as const, admin }, scope: vaultScope("v") });
    expect(inVault(true)).toBe(inVault(false));
  });

  it("confines a folder-limited token to those folders", () => {
    const t = { access: "write" as const, vaultId: "v", folders: ["design", "Docs/api"] };
    const at = (folder: string) =>
      intersect(ALL_MASK, { token: t, scope: folderScope("v", folder) });
    expect(at("design")).not.toBe(0);
    expect(at("design/mockups")).not.toBe(0);
    expect(at("docs/API/v2")).not.toBe(0);
    expect(at("designs")).toBe(0);
    expect(at("")).toBe(0);
    expect(at("docs")).toBe(0);
    // The vault itself stays visible so the token can find its folders.
    expect(intersect(ALL_MASK, { token: t, scope: vaultScope("v") })).not.toBe(0);
    // An empty list means the whole vault.
    expect(
      intersect(ALL_MASK, { token: { ...t, folders: [] }, scope: folderScope("v", "x") }),
    ).not.toBe(0);
  });
});
