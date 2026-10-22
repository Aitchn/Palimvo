import { describe, expect, it } from "vitest";
import {
  ALL_MASK,
  DEFAULT_ROLE_TEMPLATES,
  FOLDER_MASK,
  MEMBER_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_NAMES,
  SERVER_MASK,
  VAULT_ADMIN_PERMISSIONS,
  VAULT_MASK,
  hasAnyPermission,
  hasPermission,
  isPermissionName,
  maskOf,
  namesOf,
  permissionBit,
} from "./catalog.ts";

describe("catalog", () => {
  it("gives every permission its own bit below 31", () => {
    const bits = PERMISSION_NAMES.map((n) => PERMISSIONS[n].bit);
    expect(new Set(bits).size).toBe(bits.length);
    expect(Math.max(...bits)).toBeLessThan(31);
  });

  it("matches the permission list of the design", () => {
    expect(namesOf(SERVER_MASK)).toEqual([
      "server.manage",
      "users.manage",
      "roles.manage",
      "vaults.create",
      "assistant.use",
      "assistant.manage",
      "library.publish",
      "audit.view",
    ]);
    expect(namesOf(VAULT_MASK)).toHaveLength(16);
    expect(namesOf(FOLDER_MASK)).toEqual([
      "note.write",
      "note.delete",
      "file.upload",
      "proposal.review",
    ]);
    expect(ALL_MASK).toBe(SERVER_MASK | VAULT_MASK);
    expect(SERVER_MASK & VAULT_MASK).toBe(0);
  });

  it("round-trips names and masks", () => {
    expect(namesOf(maskOf(["note.write", "vault.view"]))).toEqual(["vault.view", "note.write"]);
    expect(namesOf(ALL_MASK)).toEqual(PERMISSION_NAMES);
    expect(namesOf(0)).toEqual([]);
    expect(maskOf([])).toBe(0);
    expect(permissionBit("server.manage")).toBe(1);
  });

  it("tests masks", () => {
    const m = maskOf(["note.read", "note.write"]);
    expect(hasPermission(m, "note.read")).toBe(true);
    expect(hasPermission(m, "note.read", "note.write")).toBe(true);
    expect(hasPermission(m, "note.read", "note.delete")).toBe(false);
    expect(hasAnyPermission(m, "note.delete", "note.write")).toBe(true);
    expect(hasAnyPermission(m, "note.delete")).toBe(false);
  });

  it("recognises permission names", () => {
    expect(isPermissionName("note.write")).toBe(true);
    expect(isPermissionName("note.fly")).toBe(false);
    expect(isPermissionName(3)).toBe(false);
  });

  it("defines the built-in sets", () => {
    expect(namesOf(MEMBER_PERMISSIONS)).toEqual([
      "vault.view",
      "note.read",
      "note.write",
      "note.delete",
      "file.upload",
      "history.view",
      "proposal.create",
      "mcp.connect",
    ]);
    expect(VAULT_ADMIN_PERMISSIONS).toBe(VAULT_MASK);
    expect(DEFAULT_ROLE_TEMPLATES.map((t) => t.name)).toEqual([
      "@everyone",
      "Creator",
      "AI user",
      "Reader",
    ]);
    expect(DEFAULT_ROLE_TEMPLATES.filter((t) => t.everyone)).toHaveLength(1);
  });
});
