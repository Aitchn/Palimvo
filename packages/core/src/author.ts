import { GIT_EMAIL_DOMAIN } from "./ids.ts";

/** Who made a change: a person, an AI client, a plugin acting for someone, or a program editing files directly. */
export type AuthorKind = "human" | "ai" | "plugin" | "external";

export interface Author {
  kind: AuthorKind;
  /** Stable lowercase slug, unique per kind (account name, AI client, plugin id). */
  id: string;
  /** Display name. */
  name: string;
  /** For `plugin` authors: the AI client or person the plugin acted for. */
  client?: string;
}

export const AUTHOR_KINDS: readonly AuthorKind[] = ["human", "ai", "plugin", "external"];

const MAX_NAME = 80;

/** Names end up in git metadata; keep them on one line and reasonably short. */
export function cleanName(name: string): string {
  return name
    .replace(/[\p{Cc}<>]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
}

/** `"Claude Code"` -> `"claude-code"`. Never empty. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "unknown";
}

export function makeAuthor(
  kind: AuthorKind,
  name: string,
  extra: { id?: string; client?: string } = {},
): Author {
  const clean = cleanName(name);
  const author: Author = { kind, id: slugify(extra.id ?? clean), name: clean || "Unknown" };
  const client = extra.client === undefined ? "" : cleanName(extra.client);
  if (client) author.client = client;
  return author;
}

export function sameAuthor(a: Author, b: Author): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Header/value form: `ai:Claude Code` or `plugin:Kanban/Claude Code`, URI-encoded. */
export function formatAuthor(author: Author): string {
  const name = author.client ? `${author.name}/${author.client}` : author.name;
  return encodeURIComponent(`${author.kind}:${name}`);
}

/** Inverse of {@link formatAuthor}; returns null for malformed input. */
export function parseAuthor(value: string | null | undefined): Author | null {
  if (!value) return null;
  let text: string;
  try {
    text = decodeURIComponent(value);
  } catch {
    return null;
  }
  const colon = text.indexOf(":");
  if (colon < 1) return null;
  const kind = text.slice(0, colon) as AuthorKind;
  if (!AUTHOR_KINDS.includes(kind)) return null;
  const rest = text.slice(colon + 1);
  const slash = kind === "plugin" ? rest.indexOf("/") : -1;
  const name = cleanName(slash < 0 ? rest : rest.slice(0, slash));
  if (!name) return null;
  const client = slash < 0 ? undefined : cleanName(rest.slice(slash + 1));
  return makeAuthor(kind, name, client ? { client } : {});
}

/** Synthetic address for a git author: `claude-code@ai.palimvo.local`. */
export function gitEmail(author: Author): string {
  return `${author.id}@${author.kind}.${GIT_EMAIL_DOMAIN}`;
}

/** `Claude Code <claude-code@ai.palimvo.local>` */
export function gitAuthorString(author: Author): string {
  return `${author.name} <${gitEmail(author)}>`;
}

const EMAIL_SUFFIX = `.${GIT_EMAIL_DOMAIN}`;
const EMAIL_ID = /^[a-z0-9-]+$/;

function parseGitEmail(email: string): { id: string; kind: AuthorKind } | null {
  const text = email.trim().toLowerCase();
  const at = text.indexOf("@");
  if (at < 1 || !text.endsWith(EMAIL_SUFFIX)) return null;
  const id = text.slice(0, at);
  const kind = text.slice(at + 1, text.length - EMAIL_SUFFIX.length) as AuthorKind;
  return EMAIL_ID.test(id) && AUTHOR_KINDS.includes(kind) ? { id, kind } : null;
}

/** Recovers an author from a git name/email pair; any other address is `external`, identified by the e-mail. */
export function authorFromGit(name: string, email: string): Author {
  const parsed = parseGitEmail(email);
  if (parsed) return { kind: parsed.kind, id: parsed.id, name: cleanName(name) || parsed.id };
  return makeAuthor("external", name, { id: email });
}
