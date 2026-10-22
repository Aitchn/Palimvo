import { describe, expect, it } from "vitest";
import { scopeSlotContext } from "./slots.ts";
import { bindingFor } from "./session.ts";
import { makePlugin } from "./testing.ts";

const binding = (read: string[], canRead = true) =>
  bindingFor("v", makePlugin({ id: "p", permissions: { read } }).manifest, "a".repeat(64), {
    read: canRead,
    write: false,
    propose: false,
  });

describe("scopeSlotContext", () => {
  it("passes the path when the plugin may read it", () => {
    expect(scopeSlotContext(binding(["notes"]), { path: "notes/a.md" })).toEqual({
      path: "notes/a.md",
    });
  });

  it("leaves the path out when it is outside the plugin's folders", () => {
    expect(scopeSlotContext(binding(["notes"]), { path: "private/diary.md" })).toEqual({});
  });

  it("leaves the path out when the person may not read", () => {
    expect(scopeSlotContext(binding(["**"], false), { path: "a.md" })).toEqual({});
  });

  it("is empty when nothing is open", () => {
    expect(scopeSlotContext(binding(["**"]), {})).toEqual({});
    expect(scopeSlotContext(binding(["**"]), { path: null })).toEqual({});
  });
});
