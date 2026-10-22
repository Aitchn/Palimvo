# Kanban board

Shows notes as cards on a board. Cards sit in columns by a property of the note (default
`status`); drag a card to another column, or pick the column from the menu on the card, and the
note's property is rewritten. The board also works on a phone: the menu replaces dragging.

- **Page.** "Board" in the sidebar. Type another property or a folder in the bar to change what
  the board shows. Without a folder, only notes that have the property are cards; with one, every
  note in it is, and notes without the property start in the first column.
- **Code block.** Put a board in a note:

  ````
  ```kanban
  folder: tasks
  field: status
  columns: todo, doing, done
  ```
  ````

- **New cards.** The box under the first column creates `<folder>/<title>.md` (folder `tasks`
  when the board has none).
- **Permissions.** Reads and writes the whole vault (`**`). At most 300 notes are read per board;
  narrow it with a folder in a big vault.

## Extension point `card-badge`

Other plugins can put small badges on cards (see `kanban-due`). Declare
`{ "plugin": "kanban", "point": "card-badge" }` under `contributes.extensions`, depend on
`kanban`, then:

```js
palimvo.extensions.contribute("kanban", "card-badge", ({ cards, field }) =>
  cards
    .filter((c) => c.properties.priority === "high")
    .map((c) => ({ path: c.path, text: "High", tone: "danger" })),
);
```

Input `{ cards: [{ path, title, properties }], field }`; answer
`[{ path, text, tone?, title? }]` with `tone` one of `danger`, `warning`, `success`, `accent`,
`muted`. A contributor that fails or takes more than 10 seconds only loses its own badges.
