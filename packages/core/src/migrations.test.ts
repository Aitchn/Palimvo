import { expect, it } from "vitest";
import { AppError } from "./errors.ts";
import { createMigrator } from "./migrations.ts";

const migrate = createMigrator({
  current: 3,
  migrations: [
    { version: 3, up: (d) => ({ ...d, tags: [d.tag], tag: undefined }) },
    { version: 2, up: (d) => ({ ...d, tag: d.label, label: undefined }) },
  ],
});

it("migrates from v1 straight to v3", () => {
  const input = { schemaVersion: 1, label: "x" };
  const result = migrate(input);
  expect(result).toMatchObject({ from: 1, to: 3, migrated: true });
  expect(result.data).toEqual({ schemaVersion: 3, tags: ["x"], tag: undefined, label: undefined });
  expect(input).toEqual({ schemaVersion: 1, label: "x" });
});

it("runs only the missing steps", () => {
  expect(migrate({ schemaVersion: 2, tag: "y" }).data.tags).toEqual(["y"]);
});

it("leaves current data unchanged", () => {
  const r = migrate({ schemaVersion: 3, tags: [] });
  expect(r.migrated).toBe(false);
  expect(r.data).toEqual({ schemaVersion: 3, tags: [] });
});

it("refuses future versions", () => {
  expect(() => migrate({ schemaVersion: 4 })).toThrowError(
    expect.objectContaining({ code: "schema_too_new" }),
  );
});

it("rejects malformed input", () => {
  for (const bad of [
    null,
    [],
    "x",
    {},
    { schemaVersion: 0 },
    { schemaVersion: 1.5 },
    { schemaVersion: "1" },
  ]) {
    expect(() => migrate(bad)).toThrow(AppError);
    expect(() => migrate(bad)).toThrowError(expect.objectContaining({ code: "schema_invalid" }));
  }
});

it("can assume a version for unversioned files", () => {
  const m = createMigrator({
    current: 2,
    assumeVersion: 1,
    migrations: [{ version: 2, up: (d) => ({ ...d, ok: true }) }],
  });
  expect(m({}).data).toEqual({ schemaVersion: 2, ok: true });
});

it("validates the migration table", () => {
  expect(() => createMigrator({ current: 3, migrations: [{ version: 2, up: (d) => d }] })).toThrow(
    /Missing/,
  );
  expect(() => createMigrator({ current: 2, migrations: [{ version: 5, up: (d) => d }] })).toThrow(
    /Invalid/,
  );
});
