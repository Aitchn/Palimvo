import { describe, expect, it } from "vitest";
import { FOLDER_MASK, PERMISSION_NAMES, maskOf } from "@palimvo/core";
import { GROUPS, groupsFor, permissionKey } from "./groups.ts";
import en from "../../../../packages/i18n/locales/en.json";

const flat = (id: "server" | "vault" | "folder") => groupsFor(id).flatMap((g) => g.names);

describe("permission groups", () => {
  it("place every permission in exactly one group", () => {
    const all = GROUPS.flatMap((g) => g.names);
    expect([...all].sort()).toEqual([...PERMISSION_NAMES].sort());
  });

  it("split into server, vault and folder views", () => {
    expect(flat("server")).toHaveLength(8);
    expect(flat("vault")).toHaveLength(16);
    expect(maskOf(flat("folder"))).toBe(FOLDER_MASK);
  });

  it("have a label and a hint in the English locale", () => {
    const names = (en as unknown as { permissions: { names: object; hints: object } }).permissions;
    for (const name of PERMISSION_NAMES) {
      const key = permissionKey(name).split(".").pop()!;
      expect(names.names).toHaveProperty(key);
      expect(names.hints).toHaveProperty(key);
    }
  });
});
