import { Facet } from "@codemirror/state";
import { mediaOf, type MediaKind } from "@palimvo/core";
import type { SyntaxNode } from "@lezer/common";
import { inlineParser } from "./syntax.ts";
import type { WikiLinkHost } from "./wikilinks.ts";
import { currentTheme } from "../theme/theme.ts";
import type { EditorLabels } from "./labels.ts";

/** How rendered markdown reaches the vault: link targets, file URLs, embedded notes. */
export const markdownHost = Facet.define<WikiLinkHost, WikiLinkHost | null>({
  combine: (hosts) => hosts[0] ?? null,
});

const SAFE_SCHEME = /^(https?|mailto|tel|ftp):/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A link target that leaves the vault (a web page, an email address). */
export function isExternal(href: string): boolean {
  return ANY_SCHEME.test(href) || href.startsWith("//");
}

/** The vault path a relative markdown link points to: `notes/My%20note.md#part` → `notes/My note.md`. */
export function vaultTarget(href: string, keepDot = false): string {
  let path = href.split("#")[0]!.split("?")[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw text when it is not valid percent-encoding.
  }
  // Media keep "./": it means "beside this note", not "anywhere with this name".
  return (keepDot ? path : path.replace(/^\.\//, "")).replace(/^<|>$/g, "").trim();
}

/** Follows a [text](href) link: web links open in a new tab, vault paths open the note. */
export function openHref(host: WikiLinkHost | null, href: string): void {
  // GFM autolinks: "www.example.com" and bare email addresses.
  if (/^www\./i.test(href)) href = `https://${href}`;
  else if (/^[^@\s/:]+@[^@\s/]+\.[a-z]{2,}$/i.test(href)) href = `mailto:${href}`;
  if (isExternal(href)) {
    if (SAFE_SCHEME.test(href) || href.startsWith("//"))
      window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  const target = vaultTarget(href);
  if (target && host) host.open(target);
}

/** Where to load an image from: web and data URLs as they are, vault paths through the server. */
export function mediaSrc(host: WikiLinkHost | null, url: string): string | null {
  if (/^(https?:)?\/\//i.test(url) || /^data:image\//i.test(url)) return url;
  if (isExternal(url) || !host?.fileUrl) return null;
  const resolved = host.resolve(vaultTarget(url, true));
  return resolved && mediaOf(resolved)?.kind === "image" ? host.fileUrl(resolved) : null;
}

/**
 * What `![alt](url)` points to: a vault image, sound or video, resolved against the note it is
 * in (`./a.png`, `../img/a.png`, a bare name). Web and data URLs are images as they are.
 */
export function mediaTarget(
  host: WikiLinkHost | null,
  url: string,
): { src: string; kind: MediaKind } | null {
  const image = mediaSrc(host, url);
  if (image) {
    // A web address ending in .mp4 or .mp3 is a player, not a picture.
    const kind = /^(https?:)?\/\//i.test(url) ? mediaOf(url.split(/[?#]/)[0]!)?.kind : undefined;
    return { src: image, kind: kind ?? "image" };
  }
  if (isExternal(url) || !host?.fileUrl) return null;
  const resolved = host.resolve(vaultTarget(url, true));
  const media = resolved ? mediaOf(resolved) : undefined;
  return resolved && media ? { src: host.fileUrl(resolved), kind: media.kind } : null;
}

/** `alt|300` or `alt|300x200`: Obsidian's way to size an image. */
export function imageSize(text: string): { alt: string; width?: number; height?: number } {
  const m = /^(.*?)\|\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(text);
  if (!m) return { alt: text };
  return { alt: m[1]!, width: Number(m[2]), ...(m[3] ? { height: Number(m[3]) } : {}) };
}

type Katex = typeof import("katex").default;
let katex: Promise<Katex> | undefined;

/** Renders TeX with KaTeX, which is loaded the first time a note has math. */
export function renderMath(
  el: HTMLElement,
  tex: string,
  display: boolean,
  onDone?: () => void,
): void {
  el.textContent = tex;
  katex ??= import("./katex.ts").then((m) => m.default);
  void katex.then((k) => {
    try {
      k.render(tex, el, {
        displayMode: display,
        throwOnError: false,
        output: "htmlAndMathml",
        trust: false,
      });
    } catch (error) {
      el.textContent = tex;
      el.title = String(error);
      el.classList.add("cm-math-error");
    }
    onDone?.();
  });
}

type Mermaid = typeof import("mermaid").default;
let mermaid: Promise<Mermaid> | undefined;
let diagramId = 0;
let mermaidTheme: string | undefined;

/** Draws a ```mermaid diagram; mermaid is loaded the first time a note has one. */
export function renderMermaid(
  el: HTMLElement,
  source: string,
  labels: EditorLabels,
  onDone?: () => void,
): void {
  el.textContent = labels.diagramDrawing;
  mermaid ??= import("mermaid").then((m) => m.default);
  void mermaid
    .then((m) => {
      // Re-initialised per diagram so a diagram drawn after a theme switch matches it.
      const theme = currentTheme() === "light" ? "default" : "dark";
      if (mermaidTheme !== theme) {
        m.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
        mermaidTheme = theme;
      }
      return m;
    })
    .then((m) => m.render(`palimvo-mermaid-${++diagramId}`, source))
    .then(({ svg }) => {
      el.innerHTML = svg;
    })
    .catch((error: unknown) => {
      el.textContent = labels.diagramError(error instanceof Error ? error.message : String(error));
      el.classList.add("cm-mermaid-error");
    })
    .finally(() => onDone?.());
}

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;

/** Text with [[wikilinks]] turned into links (for table cells, which are rendered outside the editor). */
function appendText(parent: HTMLElement, text: string, host: WikiLinkHost | null): void {
  let last = 0;
  for (const m of text.matchAll(WIKILINK)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const inner = m[2]!;
    const pipe = inner.indexOf("|");
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).split("#")[0]!.trim();
    const shown = pipe >= 0 ? inner.slice(pipe + 1) : inner;
    const resolved = host?.resolve(target);
    const src =
      m[1] && resolved && host?.fileUrl && mediaOf(resolved)?.kind === "image"
        ? host.fileUrl(resolved)
        : null;
    if (src) {
      const img = document.createElement("img");
      img.className = "cm-md-image";
      img.src = src;
      img.alt = target;
      const size = imageSize(shown);
      if (pipe >= 0 && size.width) img.width = size.width;
      parent.append(img);
    } else {
      const a = document.createElement("a");
      a.className = `cm-wikilink cm-wikilink-rendered${resolved ? "" : " cm-wikilink-unresolved"}`;
      a.dataset.wikilink = target;
      a.textContent = shown;
      parent.append(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** Renders one line of inline markdown (bold, links, code, math…) into `parent`. */
export function renderInline(text: string, parent: HTMLElement, host: WikiLinkHost | null): void {
  // [[links]] first: in a table cell their alias pipe is written "\|".
  let last = 0;
  for (const m of text.matchAll(CELL_WIKILINK)) {
    if (m.index > last) renderMarkdown(text.slice(last, m.index), parent, host);
    appendText(parent, m[0].replace(/\\\|/g, "|"), host);
    last = m.index + m[0].length;
  }
  if (last < text.length) renderMarkdown(text.slice(last), parent, host);
}

const CELL_WIKILINK = /!?\[\[[^[\]\n]+?\]\]/g;

function renderMarkdown(text: string, parent: HTMLElement, host: WikiLinkHost | null): void {
  const para = inlineParser.parse(text).topNode.firstChild;
  if (!para) {
    parent.append(text);
    return;
  }
  // Leading spaces are not part of the paragraph.
  if (para.from > 0) parent.append(text.slice(0, para.from));
  renderChildren(para, text, parent, host);
  if (para.to < text.length) parent.append(text.slice(para.to));
}

function renderChildren(
  node: SyntaxNode,
  text: string,
  parent: HTMLElement,
  host: WikiLinkHost | null,
  from = node.from,
  to = node.to,
): void {
  let pos = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from < from || child.to > to) continue;
    if (child.from > pos) appendText(parent, text.slice(pos, child.from), host);
    renderNode(child, text, parent, host);
    pos = child.to;
  }
  if (pos < to) appendText(parent, text.slice(pos, to), host);
}

function wrap(
  tag: string,
  node: SyntaxNode,
  text: string,
  parent: HTMLElement,
  host: WikiLinkHost | null,
  mark: string,
): void {
  const el = document.createElement(tag);
  const marks = node.getChildren(mark);
  const from = marks.length ? marks[0]!.to : node.from;
  const to = marks.length > 1 ? marks[marks.length - 1]!.from : node.to;
  renderChildren(node, text, el, host, from, to);
  parent.append(el);
}

function renderNode(
  node: SyntaxNode,
  text: string,
  parent: HTMLElement,
  host: WikiLinkHost | null,
): void {
  switch (node.name) {
    case "StrongEmphasis":
      return wrap("strong", node, text, parent, host, "EmphasisMark");
    case "Emphasis":
      return wrap("em", node, text, parent, host, "EmphasisMark");
    case "Strikethrough":
      return wrap("s", node, text, parent, host, "StrikethroughMark");
    case "Highlight":
      return wrap("mark", node, text, parent, host, "HighlightMark");
    case "InlineCode": {
      const marks = node.getChildren("CodeMark");
      const code = document.createElement("code");
      code.className = "cm-inline-code";
      code.textContent = text.slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to);
      parent.append(code);
      return;
    }
    case "InlineMath": {
      const marks = node.getChildren("MathMark");
      const span = document.createElement("span");
      span.className = "cm-math";
      renderMath(
        span,
        text.slice(marks[0]!.to, marks[1]!.from),
        marks[0]!.to - marks[0]!.from === 2,
      );
      parent.append(span);
      return;
    }
    case "Escape":
      parent.append(text.slice(node.from + 1, node.to));
      return;
    case "HardBreak":
      parent.append(document.createElement("br"));
      return;
    case "HTMLTag":
      if (/^<br\s*\/?>$/i.test(text.slice(node.from, node.to)))
        parent.append(document.createElement("br"));
      else parent.append(text.slice(node.from, node.to));
      return;
    case "URL": {
      const url = text.slice(node.from, node.to);
      parent.append(link(url, url));
      return;
    }
    case "Autolink": {
      const url = node.getChild("URL");
      const href = url ? text.slice(url.from, url.to) : "";
      parent.append(link(href, href));
      return;
    }
    case "Link": {
      const url = node.getChild("URL");
      const marks = node.getChildren("LinkMark");
      if (!url || marks.length < 2) break;
      const a = link(text.slice(url.from, url.to), "");
      renderChildren(node, text, a, host, marks[0]!.to, marks[1]!.from);
      parent.append(a);
      return;
    }
    case "Image": {
      const url = node.getChild("URL");
      const marks = node.getChildren("LinkMark");
      if (!url || marks.length < 2) break;
      const { alt, width } = imageSize(text.slice(marks[0]!.to, marks[1]!.from));
      const src = mediaSrc(host, text.slice(url.from, url.to));
      if (!src) break;
      const img = document.createElement("img");
      img.className = "cm-md-image";
      img.src = src;
      img.alt = alt;
      if (width) img.width = width;
      parent.append(img);
      return;
    }
  }
  appendText(parent, text.slice(node.from, node.to), host);
}

function link(href: string, label: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "cm-md-link cm-md-link-rendered";
  a.dataset.href = href;
  a.textContent = label;
  if (isExternal(href)) a.title = href;
  return a;
}

/** Click handling for links inside rendered widgets (tables, embeds), which the editor itself ignores. */
export function followLinkEvent(event: MouseEvent, host: WikiLinkHost | null): boolean {
  const target = event.target as HTMLElement;
  const md = target.closest<HTMLElement>("[data-href]");
  if (md) {
    event.preventDefault();
    openHref(host, md.dataset.href ?? "");
    return true;
  }
  const wiki = target.closest<HTMLElement>("[data-wikilink]");
  if (wiki && host) {
    event.preventDefault();
    host.open(wiki.dataset.wikilink ?? "");
    return true;
  }
  return false;
}
