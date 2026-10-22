import { describe, expect, it } from "vitest";
import { withExtension } from "./useFileOperations.ts";

describe("withExtension", () => {
  it("makes extensionless names notes, looking only at the last path segment", () => {
    expect(withExtension("Plan")).toBe("Plan.md");
    expect(withExtension("Plan.canvas")).toBe("Plan.canvas");
    expect(withExtension("projects.v2/Plan")).toBe("projects.v2/Plan.md");
    expect(withExtension("projects.v2/Plan.txt")).toBe("projects.v2/Plan.txt");
  });
});
