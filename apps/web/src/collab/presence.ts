import type { Author } from "@palimvo/core";

/** What other editors see next to this user's cursor (the shape y-codemirror.next reads from awareness). */
export interface PresenceUser {
  name: string;
  color: string;
  colorLight: string;
  kind: Author["kind"];
  /** The role label shown next to the name, when the person has one. */
  role?: { name: string; color?: string };
}

const KEY = "palimvo.collab.user";
const COLORS = ["#e05252", "#e0904f", "#c9a227", "#3fa964", "#2f9fb8", "#7461f0", "#c25aa8"];

/** A colour that stays the same for the same person or AI on every screen. */
export function presenceColor(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

/** The colour as a soft background for the selection (`#rrggbb` + alpha). */
function light(color: string): string {
  return `${color}33`;
}

/** Cursor identity for an author: AIs show their client's name, so everyone sees who is editing. */
export function presenceFor(
  author: Pick<Author, "kind" | "id" | "name">,
  role?: { name: string; color?: string },
): PresenceUser {
  // A role's colour wins, so a cursor looks like the badge next to the same person's changes.
  const color = role?.color ?? presenceColor(`${author.kind}:${author.id}`);
  return {
    name: author.name,
    kind: author.kind,
    color,
    colorLight: light(color),
    ...(role ? { role } : {}),
  };
}

/** A stable per-browser identity for someone who is not signed in (accounts replace it later). */
export function guestUser(label: (number: number) => string): PresenceUser {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as PresenceUser | null;
    if (saved?.name && saved.color)
      return { ...saved, colorLight: light(saved.color), kind: "human" };
  } catch {
    /* storage unavailable (private mode): fall through to a session-only identity */
  }
  const number = Math.floor(1000 + Math.random() * 9000);
  const user = presenceFor({ kind: "human", id: `guest-${number}`, name: label(number) });
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
  return user;
}
