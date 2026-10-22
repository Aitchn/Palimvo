// @vitest-environment jsdom
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownSurface } from "./MarkdownSurface.tsx";
import { noteSection } from "./embed.ts";
import { calloutKind } from "./livePreview.ts";
import { imageSize, mediaSrc, mediaTarget, vaultTarget } from "./render.ts";
import { inlineParser } from "./syntax.ts";

const links = {
  paths: () => ["Other.md", "img/cat.png", "clips/a.mp4", "clips/a.mp3"],
  resolve: (t: string) =>
    t.toLowerCase().startsWith("other")
      ? "Other.md"
      : t.endsWith("cat.png")
        ? "img/cat.png"
        : t.endsWith("a.mp4")
          ? "clips/a.mp4"
          : t.endsWith("a.mp3")
            ? "clips/a.mp3"
            : undefined,
  open: vi.fn(),
  fileUrl: (p: string) => `/raw/${p}`,
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  links.open.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** A read-only surface shows every line rendered, like a canvas card or a viewer's note. */
function show(value: string, editable = false) {
  act(() =>
    root.render(
      <MarkdownSurface
        className="editor-body"
        source={{ kind: "text", value, onChange: vi.fn() }}
        links={links}
        editable={editable}
      />,
    ),
  );
  const view = EditorView.findFromDOM(host.querySelector(".cm-content")!)!;
  // The parser works in slices; on a busy machine the first slice may not reach the end of the note.
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  act(() => view.dispatch({}));
  return view;
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);

describe("markdown syntax", () => {
  function names(text: string) {
    const out: string[] = [];
    inlineParser.parse(text).iterate({ enter: (n) => void out.push(n.name) });
    return out;
  }
  it("parses ==highlight==, $math$ and GFM", () => {
    expect(names("a ==b== c")).toContain("Highlight");
    expect(names("a $x^2$ b")).toContain("InlineMath");
    expect(names("costs $5 and $10")).not.toContain("InlineMath");
    expect(names("$$\nx\n$$")).toContain("BlockMath");
    expect(names("~~gone~~")).toContain("Strikethrough");
    expect(names("| a |\n|---|\n| 1 |")).toContain("Table");
    expect(names("- [ ] todo")).toContain("Task");
  });
});

describe("rendered markdown", () => {
  it("draws tables with alignment and inline formatting", () => {
    show("| Name | Score |\n|:--|--:|\n| **Ann** | [[Other\\|other]] |\n| `x` |  |");
    const table = q(".cm-table")!;
    expect(table).not.toBeNull();
    expect([...table.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["Name", "Score"]);
    expect(table.querySelector("td strong")?.textContent).toBe("Ann");
    expect(table.querySelector("td .cm-wikilink")?.textContent).toBe("other");
    expect(table.querySelector("td code")?.textContent).toBe("x");
    expect(table.querySelectorAll("tbody tr")[1]!.children).toHaveLength(2);
    expect((table.querySelectorAll("th")[1] as HTMLElement).style.textAlign).toBe("right");
    table
      .querySelector<HTMLElement>("td .cm-wikilink")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(links.open).toHaveBeenCalledWith("Other");
  });

  it("shows the table source while the cursor is in it", () => {
    const view = show("| a |\n|---|\n| 1 |\n\nafter", true);
    act(() => view.dispatch({ selection: { anchor: 2 } }));
    expect(q(".cm-table")).toBeNull();
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    expect(q(".cm-table")).not.toBeNull();
  });

  it("renders task checkboxes that toggle the source", () => {
    const view = show("- [ ] one\n- [x] two\n\nend", true);
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    const boxes = host.querySelectorAll<HTMLInputElement>(".cm-task-checkbox");
    expect([...boxes].map((b) => b.checked)).toEqual([false, true]);
    expect(q(".cm-task-done")?.textContent).toContain("two");
    act(() => boxes[0]!.click());
    expect(view.state.doc.toString()).toBe("- [x] one\n- [x] two\n\nend");
  });

  it("renders links, callouts, quotes, rules and code blocks", () => {
    show(
      "[site](https://example.com) and [note](Other.md)\n\n> [!warning] Careful\n> body\n\n> plain\n\n---\n\n```js\nlet a = 1;\n```",
    );
    const mdLinks = host.querySelectorAll<HTMLElement>(".cm-md-link-rendered");
    expect([...mdLinks].map((l) => l.dataset.href)).toEqual(["https://example.com", "Other.md"]);
    mdLinks[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(links.open).toHaveBeenCalledWith("Other.md");
    expect(q(".cm-callout-warning.cm-callout-title")?.textContent).toContain("Careful");
    expect(q(".cm-content")!.textContent).not.toContain("[!warning]");
    expect(q(".cm-quote")?.textContent).toBe("plain");
    expect(q(".cm-hr")).not.toBeNull();
    expect(q(".cm-codeblock-lang")?.textContent).toBe("js");
    expect(q(".cm-content")!.textContent).not.toContain("```");
  });

  it("renders images from the vault and the web", () => {
    show("![cat|120](img/cat.png) ![[cat.png]] ![x](https://example.com/a.png)");
    const imgs = [...host.querySelectorAll<HTMLImageElement>("img.cm-md-image")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
      "/raw/img/cat.png",
      "/raw/img/cat.png",
      "https://example.com/a.png",
    ]);
    expect(imgs[0]!.width).toBe(120);
  });

  it("plays sound and video written as ![](file) and ![[file]]", () => {
    show("![](clips/a.mp4)\n\n![clip](clips/a.mp3)\n\n![[a.mp4]]");
    const players = [...host.querySelectorAll<HTMLMediaElement>(".cm-embed-media")];
    expect(players.map((p) => [p.tagName, p.getAttribute("src")])).toEqual([
      ["VIDEO", "/raw/clips/a.mp4"],
      ["AUDIO", "/raw/clips/a.mp3"],
      ["VIDEO", "/raw/clips/a.mp4"],
    ]);
    expect(players.every((p) => p.controls)).toBe(true);
  });

  it("hides %%comments%% and renders footnotes, tags and highlights", () => {
    show("Text[^1] #tag ==hi== %%secret%%\n\n[^1]: note");
    const text = q(".cm-content")!.textContent!;
    expect(text).not.toContain("secret");
    expect(q(".cm-footnote-ref")?.textContent).toBe("1");
    expect(q(".cm-tag")?.textContent).toBe("#tag");
    expect(q(".cm-highlight")?.textContent).toBe("hi");
  });

  it("keeps markdown inside code as text", () => {
    show("`#notag [^1] ==x==`");
    expect(q(".cm-tag")).toBeNull();
    expect(q(".cm-footnote-ref")).toBeNull();
    expect(q(".cm-highlight")).toBeNull();
  });
});

describe("helpers", () => {
  it("resolves link targets and media", () => {
    expect(vaultTarget("./My%20note.md#part")).toBe("My note.md");
    expect(mediaSrc(links, "javascript:alert(1)")).toBeNull();
    expect(mediaSrc(links, "img/cat.png")).toBe("/raw/img/cat.png");
    expect(mediaTarget(links, "clips/a.mp4")).toEqual({ src: "/raw/clips/a.mp4", kind: "video" });
    expect(mediaTarget(links, "Other.md")).toBeNull();
    expect(mediaTarget(links, "https://example.com/a.mp4?x=1")).toEqual({
      src: "https://example.com/a.mp4?x=1",
      kind: "video",
    });
    expect(mediaTarget(links, "https://example.com/a.png")?.kind).toBe("image");
    expect(imageSize("alt|300x200")).toEqual({ alt: "alt", width: 300, height: 200 });
    expect(calloutKind("FAQ")).toBe("question");
    expect(calloutKind("custom")).toBe("note");
  });
  it("cuts a note section for ![[note#heading]]", () => {
    expect(noteSection("# A\na\n## B\nb\n### C\nc\n## D\nd", "B")).toBe("## B\nb\n### C\nc");
  });
});
