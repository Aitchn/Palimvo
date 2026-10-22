import { describe, expect, it } from "vitest";
import { reorder, sortRoles } from "./order.ts";

const role = (id: string, position: number, manageable = true) => ({ id, position, manageable });
const list = [role("a", 30), role("b", 20), role("c", 10)];

describe("reorder", () => {
  it("renumbers every role for an administrator", () => {
    expect(reorder(list, 2, 0, true)).toEqual([
      { id: "a", position: 20 },
      { id: "b", position: 10 },
      { id: "c", position: 30 },
    ]);
  });

  it("changes nothing when the role stays where it is", () => {
    expect(reorder(list, 1, 1, true)).toEqual([]);
    expect(reorder(list, 0, 9, true)).toEqual([]);
  });

  it("passes the existing rank values around for someone who is not an administrator", () => {
    expect(reorder(list, 0, 1, false)).toEqual([
      { id: "a", position: 20 },
      { id: "b", position: 30 },
    ]);
  });

  it("refuses to move past a role the person does not manage", () => {
    const mixed = [role("a", 30, false), role("b", 20), role("c", 10)];
    expect(reorder(mixed, 2, 0, false)).toEqual([]);
    expect(reorder(mixed, 2, 1, false)).toEqual([
      { id: "b", position: 10 },
      { id: "c", position: 20 },
    ]);
  });
});

describe("sortRoles", () => {
  it("puts the highest rank first and everyone last", () => {
    const roles = [
      { name: "@everyone", position: 0, everyone: true },
      { name: "B", position: 10, everyone: false },
      { name: "A", position: 10, everyone: false },
      { name: "C", position: 20, everyone: false },
    ];
    expect(sortRoles(roles).map((r) => r.name)).toEqual(["C", "A", "B", "@everyone"]);
  });
});
