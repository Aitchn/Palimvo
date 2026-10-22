import {
  canvasFileRefs,
  extractWikiLinks,
  fileKind,
  linkResolver,
  noteTitle,
  parseCanvas,
  parseFrontmatter,
  extractInlineTags,
  propertyTags,
  pathKey,
  type Backlink,
  type FileContent,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type LineMatch,
  type OutLink,
} from "@palimvo/core";
import { eachFile, type FileSource } from "./files.ts";

/** What `LinkIndex.graph` can leave out or add. */
export interface GraphOptions {
  /** Put each note's tags on its node. */
  tags?: boolean;
  /** Only the files within `depth` links of this file (either direction), with the links among them. */
  around?: string;
  /** How many links away `around` reaches; default 1. */
  depth?: number;
}

const MAX_LINES_PER_FILE = 3;
const MAX_LINE_LENGTH = 200;

interface FoundLink {
  /** The target as written (a path for the file nodes of a canvas). */
  target: string;
  embed: boolean;
  /** 1-based line in a note; 0 for a canvas. */
  line: number;
}

/** What the link queries need from one file version, worked out once per version. */
interface Derived {
  links: FoundLink[];
  /** Tags of a note, read on first use. */
  tags?: string[];
  /** The links resolved against one file list (valid while that list is the current one). */
  resolved?: { paths: readonly string[]; to: (string | undefined)[] };
}

/**
 * Backlinks, outgoing links and the link graph of a vault. Links are read from a file once per
 * version and resolved once per file list, so a backlink query over thousands of notes does not
 * parse them again.
 */
export class LinkIndex {
  private readonly derived = new WeakMap<FileContent, Derived>();

  constructor(private readonly source: FileSource) {}

  /** The files that link to or embed `target`, with the lines that do. */
  async backlinks(vault: string, requested: string): Promise<Backlink[]> {
    const paths = await this.source.list(vault);
    // Links are compared with the file's path as listed (the file system may ignore case).
    const key = pathKey(requested);
    const target = paths.find((p) => pathKey(p) === key) ?? requested;
    const resolver = linkResolver(paths);
    const found: Backlink[] = [];
    await eachFile(
      this.source,
      vault,
      paths.filter((p) => p !== target),
      (path, file) => {
        if (!file) return;
        const d = this.derive(path, file);
        const to = this.resolve(path, d, paths, resolver);
        const lines = new Set<number>();
        let linked = false;
        d.links.forEach((link, i) => {
          if (to[i] !== target) return;
          linked = true;
          if (link.line > 0) lines.add(link.line);
        });
        if (linked) found.push({ path, lines: linesOf(file.content, lines) });
      },
    );
    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** What `path` links to, in the order written, each target once. */
  async outlinks(vault: string, path: string): Promise<OutLink[]> {
    const paths = await this.source.list(vault);
    const file = this.source.cached(vault, path) ?? (await this.source.read(vault, path));
    const d = this.derive(path, file);
    const to = this.resolve(path, d, paths, linkResolver(paths));
    const seen = new Set<string>();
    const out: OutLink[] = [];
    d.links.forEach((link, i) => {
      const key = `${to[i] ?? `?${link.target}`}\0${link.embed}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ target: link.target, path: to[i] ?? null, embed: link.embed });
    });
    return out;
  }

  /** Every note, canvas and base with the links between them, or the part around one file. */
  async graph(vault: string, options: GraphOptions = {}): Promise<GraphData> {
    const paths = await this.source.list(vault);
    const resolver = linkResolver(paths);
    const nodes: GraphNode[] = paths
      .filter((p) => fileKind(p) !== "other")
      .map((path) => ({ path, title: noteTitle(path), kind: fileKind(path) }));
    const isNode = new Set(nodes.map((n) => n.path));
    const edges = new Map<string, GraphEdge>();
    const unresolved = new Map<string, { from: string; target: string }>();
    const tags = new Map<string, string[]>();
    await eachFile(this.source, vault, paths, (path, file) => {
      if (!file) return;
      const d = this.derive(path, file);
      if (options.tags && fileKind(path) === "markdown") {
        d.tags ??= noteTags(file.content);
        if (d.tags.length > 0) tags.set(path, d.tags);
      }
      const to = this.resolve(path, d, paths, resolver);
      d.links.forEach((link, i) => {
        const dest = to[i];
        if (dest === undefined) {
          unresolved.set(`${path}\0${link.target}`, { from: path, target: link.target });
        } else if (dest !== path && isNode.has(dest)) {
          const key = `${path}\0${dest}`;
          const edge = edges.get(key);
          // Between the same two files, a plain link wins over an embed.
          if (edge) edge.embed &&= link.embed;
          else edges.set(key, { from: path, to: dest, embed: link.embed });
        }
      });
    });
    for (const node of nodes) {
      const found = tags.get(node.path);
      if (found) node.tags = found;
    }
    const whole = { nodes, edges: [...edges.values()], unresolved: [...unresolved.values()] };
    return options.around === undefined ? whole : around(whole, options.around, options.depth ?? 1);
  }

  private derive(path: string, file: FileContent): Derived {
    let d = this.derived.get(file);
    if (!d) {
      d = {
        links: fileKind(path) === "canvas" ? canvasLinks(file.content) : noteLinks(file.content),
      };
      this.derived.set(file, d);
    }
    return d;
  }

  private resolve(
    path: string,
    d: Derived,
    paths: readonly string[],
    resolver: ReturnType<typeof linkResolver>,
  ): (string | undefined)[] {
    if (d.resolved?.paths !== paths) {
      d.resolved = { paths, to: d.links.map((link) => resolver.resolve(link.target, path)) };
    }
    return d.resolved.to;
  }
}

/** The tags of a note: its `tags` property and the inline `#tags` of its body. */
function noteTags(content: string): string[] {
  const { properties, body } = parseFrontmatter(content);
  return [...new Set([...propertyTags(properties), ...extractInlineTags(body)])];
}

/** The part of a graph within `depth` links of `start`, counting links in both directions. */
function around(graph: GraphData, start: string, depth: number): GraphData {
  const next = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = next.get(a);
    if (list) list.push(b);
    else next.set(a, [b]);
  };
  for (const e of graph.edges) {
    add(e.from, e.to);
    add(e.to, e.from);
  }
  const reached = new Set([start]);
  let frontier = [start];
  for (let step = 0; step < depth && frontier.length > 0; step++) {
    const found: string[] = [];
    for (const path of frontier) {
      for (const other of next.get(path) ?? []) {
        if (reached.has(other)) continue;
        reached.add(other);
        found.push(other);
      }
    }
    frontier = found;
  }
  return {
    nodes: graph.nodes.filter((n) => reached.has(n.path)),
    edges: graph.edges.filter((e) => reached.has(e.from) && reached.has(e.to)),
    unresolved: graph.unresolved.filter((u) => reached.has(u.from)),
  };
}

/** Wikilinks and embeds of a note, with their lines. Lines inside code fences do not count. */
function noteLinks(content: string): FoundLink[] {
  const links: FoundLink[] = [];
  let fence: string | null = null;
  content.split("\n").forEach((text, i) => {
    const marker = /^\s*(```+|~~~+)/.exec(text)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker.startsWith(fence)) fence = null;
      return;
    }
    if (fence !== null || !text.includes("[[")) return;
    for (const link of extractWikiLinks(text))
      links.push({ target: link.target, embed: link.embed, line: i + 1 });
  });
  return links;
}

/** Links in the text nodes of a canvas, and the files its file nodes show. */
function canvasLinks(source: string): FoundLink[] {
  let canvas;
  try {
    canvas = parseCanvas(source);
  } catch {
    return [];
  }
  const links: FoundLink[] = [];
  for (const node of canvas.nodes) {
    if (node.type !== "text") continue;
    for (const link of extractWikiLinks(node.text))
      links.push({ target: link.target, embed: link.embed, line: 0 });
  }
  for (const file of canvasFileRefs(canvas)) links.push({ target: file, embed: true, line: 0 });
  return links;
}

function linesOf(content: string, wanted: ReadonlySet<number>): LineMatch[] {
  if (wanted.size === 0) return [];
  const out: LineMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && out.length < MAX_LINES_PER_FILE; i++) {
    if (wanted.has(i + 1))
      out.push({ line: i + 1, text: lines[i]!.trim().slice(0, MAX_LINE_LENGTH) });
  }
  return out;
}
