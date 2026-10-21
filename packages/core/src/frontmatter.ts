import { isMap, parseDocument, type Document } from "yaml";
import { normalizeTag } from "./tags.ts";

export type Properties = Record<string, unknown>;

export interface FrontmatterSplit {
  /** The YAML between the fences, without them; null when the note has no frontmatter block. */
  yaml: string | null;
  /** Everything after the closing fence's line (or the whole text when there is no block). */
  body: string;
  /** Line ending the block uses, so edits keep a file's CRLF or LF. */
  eol: "\n" | "\r\n";
  /** Whether the text started with a byte order mark, which `body` no longer carries. */
  bom: boolean;
}

const BOM = "﻿";

/**
 * Splits a note into its leading `---` YAML block and the rest. A block needs an opening fence
 * on the very first line and a closing `---` (or `...`) line; anything else is plain body.
 */
export function splitFrontmatter(markdown: string): FrontmatterSplit {
  const bom = markdown.startsWith(BOM);
  const text = bom ? markdown.slice(1) : markdown;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const none: FrontmatterSplit = { yaml: null, body: text, eol, bom };
  if (!/^---[ \t]*\r?\n/.test(text)) return none;
  const open = text.indexOf("\n") + 1;
  const closing = /^(---|\.\.\.)[ \t]*$/gm;
  closing.lastIndex = open;
  const match = closing.exec(text);
  if (!match) return none;
  const yaml = text.slice(open, match.index).replace(/\r?\n$/, "");
  let end = match.index + match[0].length;
  if (text[end] === "\r") end++;
  if (text[end] === "\n") end++;
  return { yaml, body: text.slice(end), eol, bom };
}

export interface ParsedNote {
  properties: Properties;
  body: string;
  hasFrontmatter: boolean;
  /** Set when the block exists but is not a YAML map; properties is then empty and edits refuse. */
  error?: string;
}

/** Reads a note's properties. Invalid YAML never throws: the note just reports `error`. */
export function parseFrontmatter(markdown: string): ParsedNote {
  const { yaml, body } = splitFrontmatter(markdown);
  if (yaml === null) return { properties: {}, body, hasFrontmatter: false };
  if (yaml.trim() === "") return { properties: {}, body, hasFrontmatter: true };
  const doc = parseDocument(yaml, { prettyErrors: false });
  if (doc.errors.length > 0)
    return { properties: {}, body, hasFrontmatter: true, error: doc.errors[0]!.message };
  const value: unknown = doc.toJS();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      properties: {},
      body,
      hasFrontmatter: true,
      error: "frontmatter is not a map of properties",
    };
  }
  return { properties: value as Properties, body, hasFrontmatter: true };
}

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

/** Sets one property. Other properties, their order, comments and quoting stay as written. */
export function setProperty(markdown: string, key: string, value: unknown): string {
  return editFrontmatter(markdown, (doc) => doc.set(key, value));
}

/** Removes one property; the block is dropped when it ends up empty. */
export function removeProperty(markdown: string, key: string): string {
  const { yaml } = splitFrontmatter(markdown);
  if (yaml === null) return markdown;
  const edited = editFrontmatter(markdown, (doc) => doc.delete(key));
  const after = splitFrontmatter(edited);
  return after.yaml !== null && after.yaml.trim() === ""
    ? (after.bom ? BOM : "") + after.body
    : edited;
}

function editFrontmatter(markdown: string, edit: (doc: Document) => void): string {
  const { yaml, body, eol, bom } = splitFrontmatter(markdown);
  const doc = parseDocument(yaml ?? "", { prettyErrors: false });
  if (doc.errors.length > 0)
    throw new FrontmatterError(`Cannot edit invalid frontmatter: ${doc.errors[0]!.message}`);
  if (doc.contents !== null && !isMap(doc.contents))
    throw new FrontmatterError("Frontmatter is not a map of properties");
  if (doc.contents === null) doc.contents = doc.createNode({}) as never;
  edit(doc);
  let text = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\r?\n$/, "");
  if (text === "{}") text = "";
  const block = `---${eol}${text === "" ? "" : text.replace(/\r?\n/g, eol) + eol}---${eol}`;
  return (bom ? BOM : "") + block + body;
}

/** The note's tags from its `tags` / `tag` property: a list, or a comma or space separated string. */
export function propertyTags(properties: Properties): string[] {
  const out: string[] = [];
  for (const key of ["tags", "tag"]) {
    const value = properties[key];
    const items = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[\s,]+/)
        : [];
    for (const item of items) {
      const tag = typeof item === "string" ? normalizeTag(item) : "";
      if (tag !== "" && !out.includes(tag)) out.push(tag);
    }
  }
  return out;
}
