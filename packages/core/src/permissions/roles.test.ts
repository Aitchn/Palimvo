import { describe, expect, it } from "vitest";
import { maskOf } from "./catalog.ts";
import {
  canManageRole,
  canSetRolePermissions,
  highestRolePosition,
  wouldLeaveNoAdmin,
} from "./roles.ts";
import type { PermissionData, PermissionRole, PermissionSubject } from "./resolve.ts";

const roles: PermissionRole[] = [
  { id: "everyone", position: 0, permissions: 0, isEveryone: true },
  { id: "helper", position: 5, permissions: maskOf(["roles.manage", "audit.view"]) },
  { id: "lead", position: 20, permissions: maskOf(["roles.manage", "users.manage"]) },
  { id: "plain", position: 8, permissions: 0 },
];
const data: PermissionData = { roles, overrides: [] };
const person = (id: string, roleIds: string[], serverAdmin = false): PermissionSubject => ({
  id,
  serverAdmin,
  roleIds,
  vaults: new Map(),
});

describe("canManageRole", () => {
  it("lets a server administrator manage every role", () => {
    expect(canManageRole(person("a", [], true), { position: 9999 }, data)).toBe(true);
  });

  it("needs roles.manage", () => {
    expect(canManageRole(person("p", ["plain"]), { position: 1 }, data)).toBe(false);
    expect(canManageRole(null, { position: 1 }, data)).toBe(false);
  });

  it("only allows roles ranked below the actor's highest role", () => {
    const helper = person("h", ["helper"]);
    expect(canManageRole(helper, { position: 4 }, data)).toBe(true);
    expect(canManageRole(helper, { position: 5 }, data)).toBe(false);
    expect(canManageRole(helper, { position: 8 }, data)).toBe(false);
    const lead = person("l", ["lead", "helper"]);
    expect(canManageRole(lead, { position: 8 }, data)).toBe(true);
    expect(canManageRole(lead, { position: 20 }, data)).toBe(false);
  });

  it("counts the everyone role and finds the highest position", () => {
    expect(highestRolePosition(person("p", []), roles)).toBe(0);
    expect(highestRolePosition(person("p", ["plain", "helper"]), roles)).toBe(8);
    expect(highestRolePosition(person("p", []), [])).toBe(Number.NEGATIVE_INFINITY);
    expect(canManageRole(person("p", []), { position: -1 }, { roles: [], overrides: [] })).toBe(
      false,
    );
  });
});

describe("canSetRolePermissions", () => {
  const helper = person("h", ["helper"]);
  it("only lets the actor grant what they hold", () => {
    expect(canSetRolePermissions(helper, { position: 1 }, maskOf(["audit.view"]), data)).toBe(true);
    expect(
      canSetRolePermissions(helper, { position: 1 }, maskOf(["audit.view", "server.manage"]), data),
    ).toBe(false);
  });
  it("refuses roles the actor may not manage", () => {
    expect(canSetRolePermissions(helper, { position: 5 }, 0, data)).toBe(false);
    expect(canSetRolePermissions(null, { position: 1 }, 0, data)).toBe(false);
  });
  it("lets a server administrator grant anything", () => {
    expect(
      canSetRolePermissions(
        person("a", [], true),
        { position: 50 },
        maskOf(["server.manage"]),
        data,
      ),
    ).toBe(true);
  });
});

describe("wouldLeaveNoAdmin", () => {
  it("is true only when the last administrator would go", () => {
    expect(wouldLeaveNoAdmin(["a"], "a")).toBe(true);
    expect(wouldLeaveNoAdmin([], "a")).toBe(true);
    expect(wouldLeaveNoAdmin(["a", "b"], "a")).toBe(false);
    expect(wouldLeaveNoAdmin(["a"], "b")).toBe(false);
  });
});
