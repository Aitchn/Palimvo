import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import { GFM, parser as baseParser, type MarkdownConfig } from "@lezer/markdown";

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\p{P}\p{S}]/u;

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

/** Obsidian ==highlight==, parsed like GFM ~~strikethrough~~. */
const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: tags.special(tags.content) },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCTUATION.test(before);
        const pAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};

/** $inline$ and $$display$$ TeX, as in Obsidian. A lone "$5" stays text. */
const MathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: tags.special(tags.string) },
    { name: "BlockMath", block: true, style: tags.special(tags.string) },
    { name: "MathMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        if (next !== 36) return -1;
        const size = cx.char(pos + 1) === 36 ? 2 : 1;
        const start = pos + size;
        const first = cx.char(start);
        if (start >= cx.end || first === 36 || /\s/.test(String.fromCharCode(first))) return -1;
        for (let i = start + 1; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 92) {
            i++;
            continue;
          }
          if (ch !== 36) continue;
          if (size === 2 && cx.char(i + 1) !== 36) continue;
          if (
            size === 1 &&
            (/\s/.test(String.fromCharCode(cx.char(i - 1))) ||
              /\d/.test(String.fromCharCode(cx.char(i + 1))))
          )
            return -1;
          const end = i + size;
          return cx.addElement(
            cx.elt("InlineMath", pos, end, [
              cx.elt("MathMark", pos, start),
              cx.elt("MathMark", i, end),
            ]),
          );
        }
        return -1;
      },
      before: "Emphasis",
    },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      parse(cx, line) {
        if (!line.text.startsWith("$$", line.pos)) return false;
        const start = cx.lineStart + line.pos;
        const marks = [cx.elt("MathMark", start, start + 2)];
        const rest = line.text.slice(line.pos + 2).trimEnd();
        // $$ x $$ on one line.
        if (rest.length >= 2 && rest.endsWith("$$")) {
          const end = cx.lineStart + line.pos + 2 + rest.length;
          marks.push(cx.elt("MathMark", end - 2, end));
          cx.nextLine();
          cx.addElement(cx.elt("BlockMath", start, end, marks));
          return true;
        }
        let end = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          const trimmed = line.text.trimEnd();
          if (trimmed.endsWith("$$")) {
            const close = cx.lineStart + trimmed.length;
            marks.push(cx.elt("MathMark", close - 2, close));
            end = close;
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("BlockMath", start, end, marks));
        return true;
      },
      before: "FencedCode",
    },
  ],
};

/** Obsidian-flavoured markdown: CommonMark + GFM (tables, tasks, ~~strike~~, autolinks) + ==highlight== + math. */
export const markdownExtensions = [GFM, Highlight, MathSyntax];

/** The editor's markdown language, with syntax highlighting for fenced code in any common language. */
export function markdownSupport() {
  return markdown({
    base: commonmarkLanguage,
    codeLanguages: languages,
    extensions: markdownExtensions,
  });
}

/** A standalone parser for small pieces of markdown, such as table cells. */
export const inlineParser = baseParser.configure(markdownExtensions);
