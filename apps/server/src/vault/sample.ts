/** English example content the setup wizard can put into the first vault. */
export const SAMPLE_FILES: readonly { path: string; content: string }[] = [
  {
    path: "Getting started.md",
    content: `---
tags: [guide]
---

# Getting started

Palimvo keeps your notes as plain Markdown files. Everything here also opens in Obsidian.

- Write in [[Markdown basics]] and link notes with \`[[double brackets]]\`.
- Sketch ideas on the [[Example board.canvas|example canvas]].
- Every change is saved with its author in the version history, whether a person or an AI made it.
- Connect an AI from the settings: it edits the same notes you are typing in.

Delete these example notes whenever you like.
`,
  },
  {
    path: "Markdown basics.md",
    content: `# Markdown basics

**Bold**, *italic*, ~~strikethrough~~ and \`code\`.

## Lists and tasks

- [x] Open this vault
- [ ] Write your first note
- [ ] Invite someone else

> [!tip] Callouts
> A callout draws attention to a tip, a warning or a question.

Back to [[Getting started]].
`,
  },
  {
    path: "Ideas/First idea.md",
    content: `---
tags: [idea]
status: draft
---

# First idea

Folders group notes. Tags and properties like the ones at the top of this note let you build
tables and boards from them later.

See also [[Getting started]].
`,
  },
  {
    path: "Example board.canvas",
    content: JSON.stringify(
      {
        nodes: [
          {
            id: "welcome",
            type: "file",
            file: "Getting started.md",
            x: 0,
            y: 0,
            width: 320,
            height: 220,
          },
          {
            id: "markdown",
            type: "file",
            file: "Markdown basics.md",
            x: 420,
            y: 0,
            width: 320,
            height: 220,
          },
          {
            id: "text",
            type: "text",
            text: "A canvas holds notes, text and images.\nDrag to rearrange.",
            x: 210,
            y: 300,
            width: 320,
            height: 100,
          },
        ],
        edges: [
          { id: "e1", fromNode: "welcome", toNode: "markdown" },
          { id: "e2", fromNode: "welcome", toNode: "text" },
        ],
      },
      null,
      2,
    ),
  },
];
