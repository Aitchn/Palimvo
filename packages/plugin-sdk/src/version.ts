/**
 * Version helpers for plugin versions and `dependencies` ranges: a small subset of npm semver,
 * kept here (no dependencies) so the browser, the server and the CLI agree.
 */

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

/** A complete `major.minor.patch[-pre]` version, as required for a plugin's own `version`. */
export const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function isStrictVersion(value: string): boolean {
  return STRICT_VERSION.test(value);
}

/** Compares "1.2.10" with "1.2.9" part by part; a pre-release ("1.0.0-beta") sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/i, "").split("-", 2);
    return { parts: core.split(".").map((x) => Number.parseInt(x, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

interface Comparator {
  op: ">=" | "<=" | ">" | "<" | "=";
  version: string;
}

/**
 * Parses "*", "1.2.3", "=1.2.3", ">=1.2.3", "<2.0.0", "^1.2.3", "~1.2.3", several separated by
 * spaces (all must hold) and alternatives separated by "||". Returns null for anything else.
 */
export function parseVersionRange(range: string): Comparator[][] | null {
  const alternatives = range.trim() === "" ? ["*"] : range.split("||").map((part) => part.trim());
  // "^1.0.0 ||" would otherwise add an empty set that matches every version.
  if (alternatives.some((part) => part === "")) return null;
  const result: Comparator[][] = [];
  for (const alternative of alternatives) {
    const set: Comparator[] = [];
    for (const token of alternative.split(/\s+/).filter(Boolean)) {
      if (token === "*" || token === "x" || token === "latest") continue;
      const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
      const v = m && VERSION.exec(m[2] ?? "");
      if (!m || !v) return null;
      const major = Number(v[1]);
      const minor = Number(v[2] ?? 0);
      const patch = Number(v[3] ?? 0);
      const exact = `${major}.${minor}.${patch}${v[4] ? `-${v[4]}` : ""}`;
      if (m[1] === "^") {
        set.push({ op: ">=", version: exact });
        const upper =
          major > 0 || v[2] === undefined
            ? `${major + 1}.0.0`
            : minor > 0 || v[3] === undefined
              ? `0.${minor + 1}.0`
              : `0.0.${patch + 1}`;
        set.push({ op: "<", version: upper });
      } else if (m[1] === "~") {
        set.push({ op: ">=", version: exact });
        set.push({
          op: "<",
          version: v[2] === undefined ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`,
        });
      } else {
        set.push({ op: (m[1] as Comparator["op"] | undefined) ?? "=", version: exact });
      }
    }
    result.push(set);
  }
  return result;
}

export function isVersionRange(range: string): boolean {
  return parseVersionRange(range) !== null;
}

/** Whether `version` is inside `range`; an invalid range matches nothing. */
export function satisfiesVersion(version: string, range: string | undefined): boolean {
  const parsed = parseVersionRange(range ?? "*");
  if (!parsed) return false;
  return parsed.some((set) =>
    set.every(({ op, version: bound }) => {
      const d = compareVersions(version, bound);
      return op === "="
        ? d === 0
        : op === ">="
          ? d >= 0
          : op === "<="
            ? d <= 0
            : op === ">"
              ? d > 0
              : d < 0;
    }),
  );
}
