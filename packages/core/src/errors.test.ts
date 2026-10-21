import { expect, it } from "vitest";
import {
  AppError,
  ERROR_CODE_LIST,
  ERROR_CODES,
  isErrorCode,
  parseErrorBody,
  toAppError,
} from "./errors.ts";

it("registers an http status and message for every code", () => {
  for (const code of ERROR_CODE_LIST) {
    expect(ERROR_CODES[code].status).toBeGreaterThanOrEqual(400);
    expect(ERROR_CODES[code].message).not.toBe("");
  }
});

it("defaults status and message from the code", () => {
  const e = new AppError("version_conflict", undefined, { current: "abc" });
  expect(e.httpStatus).toBe(409);
  expect(e.toJSON()).toEqual({
    code: "version_conflict",
    message: ERROR_CODES.version_conflict.message,
    details: { current: "abc" },
  });
  expect(e).toBeInstanceOf(Error);
});

it("allows overriding status and message, and omits absent details", () => {
  const e = new AppError("forbidden", 404, undefined, { message: "hidden" });
  expect(e.httpStatus).toBe(404);
  expect(e.toJSON()).toEqual({ code: "forbidden", message: "hidden" });
});

it("wraps unknown errors as internal without leaking the message", () => {
  const cause = new Error("secret path /etc/x");
  const e = toAppError(cause);
  expect(e.code).toBe("internal");
  expect(e.httpStatus).toBe(500);
  expect(e.message).not.toContain("secret");
  expect(e.cause).toBe(cause);
  const own = new AppError("not_found");
  expect(toAppError(own)).toBe(own);
});

it("parses error bodies", () => {
  expect(isErrorCode("not_found")).toBe(true);
  expect(isErrorCode("toString")).toBe(false);
  expect(parseErrorBody({ code: "not_found", message: "x" })).toEqual({
    code: "not_found",
    message: "x",
  });
  expect(parseErrorBody({ code: "nope", message: "x" })).toBeNull();
  expect(parseErrorBody("x")).toBeNull();
});
