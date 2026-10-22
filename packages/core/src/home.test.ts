import { describe, expect, it } from "vitest";
import { defaultHomeConfig, migrateHomeConfig } from "./home.ts";

describe("home config", () => {
  it("starts with proposals, the activity wall and pinned notes", () => {
    const config = defaultHomeConfig();
    expect(config.widgets.map((w) => w.type)).toEqual(["proposals", "activity", "pinned"]);
    expect(config.pinned).toEqual([]);
    expect(config.publicNote).toBeNull();
  });

  it("round-trips through the migrator and refuses newer files", () => {
    const config = defaultHomeConfig();
    expect(migrateHomeConfig(config).data).toEqual(config);
    expect(() => migrateHomeConfig({ ...config, schemaVersion: 2 })).toThrow();
    expect(() => migrateHomeConfig({ widgets: [] })).toThrow();
  });
});
