import { describe, expect, it } from "vitest";
import { MAX_WRITE_CHARS, PROTOCOL_VERSION, parseRpc, plainData } from "./protocol.ts";

const rpc = (method: string, params: unknown = {}, extra: Record<string, unknown> = {}) => ({
  type: "rpc",
  schemaVersion: PROTOCOL_VERSION,
  requestId: "abc:1",
  method,
  params,
  ...extra,
});

describe("parseRpc", () => {
  it("accepts a well-formed request and copies its parameters", () => {
    const params = { path: "a.md" };
    const parsed = parseRpc(rpc("vault.read", params));
    expect(parsed).toEqual({ requestId: "abc:1", method: "vault.read", params: { path: "a.md" } });
    expect(parsed.params).not.toBe(params);
  });

  it.each([
    ["not an object", "hello"],
    ["an array", []],
    ["a missing type", { ...rpc("vault.read", { path: "a" }), type: undefined }],
    ["the wrong protocol version", rpc("vault.read", { path: "a" }, { schemaVersion: 9 })],
    ["extra fields", rpc("vault.read", { path: "a" }, { sneaky: 1 })],
    ["an unknown method", rpc("vault.delete", { path: "a" })],
    ["a request id with spaces", rpc("vault.read", { path: "a" }, { requestId: "a b" })],
    ["a very long request id", rpc("vault.read", { path: "a" }, { requestId: "x".repeat(200) })],
    ["unexpected parameters", rpc("vault.read", { path: "a", admin: true })],
    ["parameters that are an array", rpc("vault.read", [])],
    ["a non-string path", rpc("vault.read", { path: 5 })],
    ["a missing path", rpc("vault.read", {})],
    ["a write without content", rpc("vault.write", { path: "a" })],
    ["a search without a query", rpc("vault.search", {})],
    ["a limit above 100", rpc("vault.search", { query: "x", limit: 1000 })],
    ["a fractional limit", rpc("vault.search", { query: "x", limit: 1.5 })],
    ["a notice without a message", rpc("ui.showNotice", {})],
    ["a non-boolean recursive", rpc("vault.list", { recursive: "yes" })],
    ["a graph depth of 0", rpc("vault.graph", { depth: 0 })],
    ["a graph depth above the limit", rpc("vault.graph", { depth: 7 })],
    ["graph tags that are not a boolean", rpc("vault.graph", { tags: 1 })],
    [
      "text over the size limit",
      rpc("vault.write", { path: "a", content: "x".repeat(MAX_WRITE_CHARS + 1) }),
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => parseRpc(value)).toThrow();
  });

  it("rejects parameters whose prototype was swapped", () => {
    class Evil {
      path = "a.md";
    }
    expect(() => parseRpc(rpc("vault.read", new Evil()))).toThrow();
  });

  it("accepts parameters created without a prototype", () => {
    const params = Object.assign(Object.create(null) as object, { path: "a.md" });
    expect(parseRpc(rpc("vault.read", params)).params).toEqual({ path: "a.md" });
  });
});

describe("plainData", () => {
  it("round-trips JSON and drops functions and prototypes", () => {
    const value = { a: 1, f: () => 1, nested: { b: [1, 2] } };
    expect(plainData(value, "x")).toEqual({ a: 1, nested: { b: [1, 2] } });
  });

  it("turns undefined into null", () => {
    expect(plainData(undefined, "x")).toBeNull();
  });

  it("refuses cycles and oversized data", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => plainData(cycle, "Input")).toThrow(/plain data/);
    expect(() => plainData("x".repeat(100), "Input", 50)).toThrow(/larger/);
  });
});
