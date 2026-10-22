import { EditorState, Facet, type Extension } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { fileKind, mediaOf, noteTitle } from "@palimvo/core";
import { editorLabels, type EditorLabels } from "./labels.ts";
import { imageSize, markdownHost } from "./render.ts";
import type { WikiLinkHost } from "./wikilinks.ts";

/** How many ![[note]] embeds deep this editor is; embeds stop nesting after a couple of levels. */
export const embedDepth = Facet.define<number, number>({ combine: (v) => v[0] ?? 0 });
const MAX_DEPTH = 2;

/** Set by MarkdownSurface: the read-only rendering an embedded note is shown with. */
let renderer: ((host: WikiLinkHost, depth: number, labels: EditorLabels) => Extension) | undefined;
export function setEmbedRenderer(
  fn: (host: WikiLinkHost, depth: number, labels: EditorLabels) => Extension,
): void {
  renderer = fn;
}

/** The part of a note under `# heading`, up to the next heading of the same or a higher level. */
export function noteSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const want = heading.trim().toLowerCase();
  const start = lines.findIndex(
    (l) =>
      /^#{1,6}\s/.test(l) &&
      l
        .replace(/^#{1,6}\s+/, "")
        .trim()
        .toLowerCase() === want,
  );
  if (start < 0) return text;
  const level = /^#+/.exec(lines[start]!)![0].length;
  let end = start + 1;
  while (
    end < lines.length &&
    !(/^#{1,6}\s/.test(lines[end]!) && /^#+/.exec(lines[end]!)![0].length <= level)
  )
    end++;
  return lines.slice(start, end).join("\n");
}

function withoutFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** ![[file]]: an image, sound or video plays in place; a note is shown inside this one. */
export class EmbedWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly section: string,
    readonly options: string,
  ) {
    super();
  }

  eq(other: EmbedWidget): boolean {
    return (
      other.path === this.path && other.section === this.section && other.options === this.options
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const host = view.state.facet(markdownHost);
    const media = mediaOf(this.path);
    if (media && host?.fileUrl) {
      const src = host.fileUrl(this.path);
      if (media.kind === "image") {
        const img = document.createElement("img");
        img.className = "cm-md-image";
        img.src = src;
        img.alt = this.path;
        const { width, height } = imageSize(`|${this.options}`);
        if (width) img.width = width;
        if (height) img.height = height;
        img.onload = () => view.requestMeasure();
        return img;
      }
      const el = document.createElement(media.kind);
      el.className = `cm-embed-media cm-embed-${media.kind}`;
      el.controls = true;
      el.preload = "metadata";
      el.src = src;
      el.onloadedmetadata = () => view.requestMeasure();
      return el;
    }

    const box = document.createElement("span");
    box.className = "cm-embed";
    const title = document.createElement("span");
    title.className = "cm-embed-title cm-wikilink cm-wikilink-rendered";
    title.textContent = this.section
      ? `${noteTitle(this.path)} › ${this.section}`
      : noteTitle(this.path);
    title.onmousedown = (e) => {
      e.preventDefault();
      host?.open(this.path);
    };
    const body = document.createElement("span");
    body.className = "cm-embed-body";
    box.append(title, body);
    const depth = view.state.facet(embedDepth);
    if (fileKind(this.path) !== "markdown" || !host?.readText || !renderer || depth >= MAX_DEPTH)
      return box;

    const labels = view.state.facet(editorLabels);
    body.textContent = labels.loading;
    let inner: EditorView | undefined;
    let gone = false;
    host
      .readText(this.path)
      .then((text) => {
        if (gone) return;
        body.textContent = "";
        const shown = withoutFrontmatter(this.section ? noteSection(text, this.section) : text);
        inner = new EditorView({
          parent: body,
          state: EditorState.create({
            doc: shown,
            extensions: [
              renderer!(host, depth + 1, labels),
              EditorView.editable.of(false),
              EditorState.readOnly.of(true),
            ],
          }),
        });
        view.requestMeasure();
      })
      .catch(() => {
        body.textContent = labels.embedFailed;
      });
    (box as HTMLElement & { destroyEmbed?: () => void }).destroyEmbed = () => {
      gone = true;
      inner?.destroy();
    };
    return box;
  }

  destroy(dom: HTMLElement): void {
    (dom as HTMLElement & { destroyEmbed?: () => void }).destroyEmbed?.();
  }

  ignoreEvent(): boolean {
    return true;
  }
}
