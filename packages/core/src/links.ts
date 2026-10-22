import { pathKey } from "./paths.ts";

export interface WikiLink {
  /** Target note name or path, without heading/block/alias parts. */
  target: string;
  heading?: string;
  /** Block id of `[[note#^block]]`, without the caret. */
  block?: string;
  alias?: string;
  embed: boolean;
}

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;

/** Removes fenced and inline code, where link and tag syntax does not apply. */
export function stripCode(markdown: string): string {
  return markdown
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, "")
    .replace(/(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, "");
}

/** Extracts Obsidian-style [[wikilinks]] and ![[embeds]] from markdown, skipping code. */
export function extractWikiLinks(markdown: string): WikiLink[] {
  const withoutCode = stripCode(markdown);
  const links: WikiLink[] = [];
  for (const match of withoutCode.matchAll(WIKILINK)) {
    const raw = match[2]!;
    const [targetPart = "", alias] = raw.split("|", 2);
    const [target = "", fragment] = targetPart.split("#", 2);
    if (target.trim() === "" && !fragment) continue;
    const trimmed = fragment?.trim();
    const block = trimmed?.startsWith("^") ? trimmed.slice(1) : undefined;
    links.push({
      target: target.trim(),
      heading: block !== undefined ? undefined : trimmed || undefined,
      block: block || undefined,
      alias: alias?.trim() || undefined,
      embed: match[1] === "!",
    });
  }
  return links;
}

/**
 * Resolves a wikilink target to a vault path the way Obsidian does: exact path
 * first, then relative to the linking note's folder, then the shortest path
 * whose file name matches. Targets without an extension get ".md" appended.
 *
 * The lookup tables for a frozen `paths` array are built once and reused for every call
 * with it, so resolving all links of a large vault stays linear (see linkResolver).
 */
export function resolveWikiLink(
  target: string,
  paths: readonly string[],
  fromPath?: string,
): string | undefined {
  return linkResolver(paths).resolve(target, fromPath);
}

/**
 * `target` (with "." and ".." segments) followed from the folder of the note at `fromPath`;
 * undefined when it climbs out of the vault.
 */
function joinRelative(target: string, fromPath: string | undefined): string | undefined {
  const parts = fromPath?.includes("/")
    ? fromPath.slice(0, fromPath.lastIndexOf("/")).split("/")
    : [];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

/** Wikilink resolution over one fixed list of paths, with O(1) lookups instead of a scan per link. */
export class LinkResolver {
  /** Lower-cased path -> path (the last one wins, as a Map built in order would). */
  private readonly byLower = new Map<string, string>();
  /** Lower-cased file name -> indexes of the paths with that name, in order. */
  private readonly byName = new Map<string, number[]>();

  constructor(private readonly paths: readonly string[]) {
    paths.forEach((p, i) => {
      const lower = pathKey(p);
      this.byLower.set(lower, p);
      const name = lower.slice(lower.lastIndexOf("/") + 1);
      const list = this.byName.get(name);
      if (list) list.push(i);
      else this.byName.set(name, [i]);
    });
  }

  resolve(target: string, fromPath?: string): string | undefined {
    const clean = target.trim().replace(/^\/+/, "");
    if (clean === "") return undefined;
    // "./a.png" and "../img/a.png" name a place relative to the note, as in any Markdown file.
    if (/(^|\/)\.\.?(\/|$)/.test(clean)) {
      const joined = joinRelative(clean, fromPath);
      if (joined === undefined) return undefined;
      return this.byLower.get(pathKey(joined)) ?? this.byLower.get(pathKey(`${joined}.md`));
    }
    const candidates = [clean, `${clean}.md`].map(pathKey);
    for (const c of candidates) {
      const hit = this.byLower.get(c);
      if (hit) return hit;
    }
    if (fromPath?.includes("/")) {
      const folder = pathKey(fromPath.slice(0, fromPath.lastIndexOf("/") + 1));
      for (const c of candidates) {
        const hit = this.byLower.get(folder + c);
        if (hit) return hit;
      }
    }
    // The shortest path ending in "/<candidate>"; among equally short ones, the first in order.
    let best = -1;
    for (const c of candidates) {
      for (const i of this.byName.get(c.slice(c.lastIndexOf("/") + 1)) ?? []) {
        const p = this.paths[i]!;
        if (!pathKey(p).endsWith(`/${c}`)) continue;
        if (
          best < 0 ||
          p.length < this.paths[best]!.length ||
          (p.length === this.paths[best]!.length && i < best)
        )
          best = i;
      }
    }
    return best < 0 ? undefined : this.paths[best];
  }
}

const resolvers = new WeakMap<readonly string[], LinkResolver>();

/**
 * The resolver for `paths`. It is reused only for a frozen array (which cannot change), so pass
 * `Object.freeze(list)` when resolving many links against the same list; any other array gets
 * fresh tables on every call.
 */
export function linkResolver(paths: readonly string[]): LinkResolver {
  if (!Object.isFrozen(paths)) return new LinkResolver(paths);
  let resolver = resolvers.get(paths);
  if (!resolver) resolvers.set(paths, (resolver = new LinkResolver(paths)));
  return resolver;
}

/** Display name of a note: file name without the .md extension. */
export function noteTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "");
}
