import type { RoleRow } from "../api/admin.ts";

export interface PositionChange {
  id: string;
  position: number;
}

/** Roles in the order the pages show them: highest rank first, @everyone last. */
export function sortRoles<T extends Pick<RoleRow, "position" | "name" | "everyone">>(
  roles: readonly T[],
): T[] {
  return [...roles].sort(
    (a, b) =>
      Number(a.everyone) - Number(b.everyone) ||
      b.position - a.position ||
      a.name.localeCompare(b.name),
  );
}

/**
 * The new positions after moving the role at `from` to `to` in the list shown (highest first,
 * @everyone excluded). An administrator may renumber every role; anyone else only passes around
 * the rank values of roles they already manage, so nothing ends up above their own rank.
 * Returns only the roles whose position changes.
 */
export function reorder(
  roles: readonly Pick<RoleRow, "id" | "position" | "manageable">[],
  from: number,
  to: number,
  isAdmin: boolean,
): PositionChange[] {
  if (from === to || from < 0 || to < 0 || from >= roles.length || to >= roles.length) return [];
  const next = [...roles];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  const target = new Map<string, number>();
  if (isAdmin) {
    next.forEach((r, i) => target.set(r.id, (next.length - i) * 10));
  } else {
    const slots = roles
      .filter((r) => r.manageable)
      .map((r) => r.position)
      .sort((a, b) => b - a);
    let used = 0;
    for (const r of next) if (r.manageable) target.set(r.id, slots[used++]!);
    if (next.some((r) => !r.manageable && roles.indexOf(r) !== next.indexOf(r))) return [];
  }
  return roles.flatMap((r) =>
    target.has(r.id) && target.get(r.id) !== r.position
      ? [{ id: r.id, position: target.get(r.id)! }]
      : [],
  );
}
