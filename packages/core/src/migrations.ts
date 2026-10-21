import { AppError } from "./errors.ts";

/** One step: turns data at `version - 1` into data at `version`. Must be a pure function. */
export interface Migration<T = Record<string, unknown>> {
  version: number;
  up(data: T): T;
}

export interface MigrationResult<T> {
  data: T & { schemaVersion: number };
  from: number;
  to: number;
  /** True when at least one step ran. */
  migrated: boolean;
}

export interface MigratorOptions<T> {
  /** Newest version this build understands. */
  current: number;
  /** Steps for versions 2..current, in any order. */
  migrations: ReadonlyArray<Migration<T>>;
  /** Version assumed when `schemaVersion` is absent (files written before versioning). Default: reject. */
  assumeVersion?: number;
}

/**
 * Builds a migrator for a versioned JSON document (vault config, home.json, proposals).
 * Input is never mutated (it must be JSON-compatible). Data from a newer version is refused (`schema_too_new`),
 * malformed versions or missing steps are `schema_invalid`.
 */
export function createMigrator<T extends Record<string, unknown> = Record<string, unknown>>(
  options: MigratorOptions<T>,
) {
  const { current, migrations, assumeVersion } = options;
  const steps = new Map<number, Migration<T>>();
  for (const step of migrations) {
    if (
      !Number.isInteger(step.version) ||
      step.version < 2 ||
      step.version > current ||
      steps.has(step.version)
    ) {
      throw new Error(`Invalid migration version ${step.version}`);
    }
    steps.set(step.version, step);
  }
  for (let v = 2; v <= current; v++) {
    if (!steps.has(v)) throw new Error(`Missing migration to version ${v}`);
  }

  return function migrate(input: unknown): MigrationResult<T> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new AppError("schema_invalid", undefined, { reason: "not an object" });
    }
    const raw = (input as Record<string, unknown>).schemaVersion ?? assumeVersion;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      throw new AppError("schema_invalid", undefined, {
        reason: "bad schemaVersion",
        schemaVersion: raw,
      });
    }
    if (raw > current) {
      throw new AppError("schema_too_new", undefined, { schemaVersion: raw, supported: current });
    }
    let data = JSON.parse(JSON.stringify(input)) as T;
    for (let v = raw + 1; v <= current; v++) {
      data = steps.get(v)!.up(data);
    }
    return {
      data: { ...data, schemaVersion: current },
      from: raw,
      to: current,
      migrated: raw !== current,
    };
  };
}
