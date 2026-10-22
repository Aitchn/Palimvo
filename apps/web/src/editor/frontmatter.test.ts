import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  frontmatterRange,
  frontmatterState,
  initialBodySelection,
  setFrontmatterExpanded,
} from "./frontmatter.ts";

const note =
  "---\n# Keep this comment\nstatus: accepted\ntags: [one, two]\nrelated: '[[Other]]'\nsummary: |\n  More than one line\n---\n# Body\n";
function state(doc = note) {
  return EditorState.create({ doc, extensions: [frontmatterState] });
}

describe("leading YAML properties", () => {
  it.each([
    note,
    "---\n{status: accepted, tags: [one, two]}\n---\nBody",
    note.replaceAll("\n", "\r\n"),
  ])("collapses complete property maps: %s", (doc) => {
    const value = state(doc);
    expect(frontmatterRange(value.doc)).toEqual({
      from: 0,
      to: value.doc.toString().indexOf("\n---", 4) + 4,
    });
    expect(value.field(frontmatterState).expanded).toBe(false);
    expect(initialBodySelection(value)).toBe(value.field(frontmatterState).range!.to + 1);
  });

  it.each([
    "# Body\n---\nstatus: accepted\n---", // not leading
    "---\nA paragraph\n---\nBody", // horizontal rules around ordinary text
    "---\n---\nBody", // no properties
    "```yaml\n---\nstatus: accepted\n---\n```", // fenced source
    "---\nstatus: accepted", // incomplete frontmatter
    "---\ntags: [one\n---\nBody", // malformed YAML
    "---\n- one\n- two\n---\nBody", // not a property map
  ])("keeps non-properties and malformed content visible: %s", (doc) => {
    const value = state(doc);
    expect(value.field(frontmatterState).range).toBeNull();
    expect(value.field(frontmatterState).decorations.size).toBe(0);
    expect(value.doc.toString()).toBe(doc);
  });

  it("never changes YAML when toggled repeatedly or when editing the body", () => {
    let value = state();
    for (let n = 0; n < 8; n++) {
      const tr = value.update({ effects: setFrontmatterExpanded.of(n % 2 === 0) });
      expect(tr.docChanged).toBe(false);
      value = tr.state;
      expect(value.doc.toString()).toBe(note);
    }
    value = value.update({ changes: { from: value.doc.length, insert: "Body edit" } }).state;
    expect(value.field(frontmatterState).expanded).toBe(false);
    expect(value.doc.toString()).toBe(note + "Body edit");
  });

  it("reveals source for search/navigation and allows metadata edits", () => {
    let value = state();
    value = value.update({ selection: EditorSelection.cursor(note.indexOf("accepted")) }).state;
    expect(value.field(frontmatterState).expanded).toBe(true);
    value = value.update({ changes: { from: note.indexOf("accepted"), insert: "not-" } }).state;
    expect(value.doc.toString()).toContain("status: not-accepted");
    expect(value.field(frontmatterState).expanded).toBe(true);
  });

  it("reveals invalid YAML after external edits and collapses newly added properties", () => {
    let value = state();
    value = value.update({ changes: { from: note.indexOf("[one"), insert: "[" } }).state;
    expect(value.field(frontmatterState).range).toBeNull();
    value = value.update({ changes: { from: 0, to: value.doc.length, insert: note } }).state;
    expect(value.field(frontmatterState).expanded).toBe(false);
  });
});
