import { expect, it } from "vitest";
import { PACKAGE } from "./index.ts";

it("exports its package name", () => {
  expect(PACKAGE).toBe("@palimvo/core");
});
