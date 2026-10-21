import { expect, it } from "vitest";
import {
  ENV,
  ENV_PREFIX,
  LEGACY_AUTHOR_HEADER,
  STORAGE_KEY_RENAMES,
  STORAGE_KEYS,
  isVaultMetaPath,
  migrateLegacyMetaPath,
  readCompatHeader,
} from "./ids.ts";

it("uses the PALIMVO_ prefix for every env var", () => {
  for (const name of Object.values(ENV)) expect(name.startsWith(ENV_PREFIX)).toBe(true);
});

it("renames legacy meta paths and leaves others alone", () => {
  expect(migrateLegacyMetaPath(".aivault")).toBe(".palimvo");
  expect(migrateLegacyMetaPath(".aivault/plugins/a.js")).toBe(".palimvo/plugins/a.js");
  expect(migrateLegacyMetaPath(".aivault-notes/a.md")).toBe(".aivault-notes/a.md");
  expect(migrateLegacyMetaPath("notes/.aivault/a")).toBe("notes/.aivault/a");
});

it("recognises meta folders", () => {
  expect(isVaultMetaPath(".palimvo/config.json")).toBe(true);
  expect(isVaultMetaPath(".aivault")).toBe(true);
  expect(isVaultMetaPath(".palimvo-x/a")).toBe(false);
});

it("reads the current header first, then the legacy one", () => {
  const headers: Record<string, string> = { [LEGACY_AUTHOR_HEADER]: "old" };
  const get = (n: string) => headers[n];
  expect(readCompatHeader(get, "x-palimvo-author", LEGACY_AUTHOR_HEADER)).toBe("old");
  headers["x-palimvo-author"] = "new";
  expect(readCompatHeader(get, "x-palimvo-author", LEGACY_AUTHOR_HEADER)).toBe("new");
  expect(readCompatHeader(() => undefined, "a", "b")).toBeNull();
});

it("maps legacy storage keys to palimvo.* keys", () => {
  expect(STORAGE_KEY_RENAMES).toContainEqual(["aitchn.theme", STORAGE_KEYS.theme]);
  expect(STORAGE_KEY_RENAMES).toContainEqual(["cairn-outbox", STORAGE_KEYS.outbox]);
});
