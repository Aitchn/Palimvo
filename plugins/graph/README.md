# Graph view

Shows how notes link to each other, in two places:

- **Graph page** (sidebar → Plugin views → Graph): every note, canvas and database of the vault as
  a dot and every `[[link]]` or `![[embed]]` as a line. Dots are bigger the more links they have
  and colored by folder, tag or file type. Hover a dot to light up its links, click it to open the
  note, drag it to move it, scroll to zoom and drag the background to pan. The search box finds a
  note or tag by name (Enter opens the best match); the toggles hide embeds and unlinked notes,
  add a node per tag (only tags used by two or more notes) and limit the picture to one top-level
  folder.
- **Local graph** (details panel, under the open note): the notes within one to three links of the
  open note, nearest first, at most 250 of them.

It reads the vault's link graph through `palimvo.vault.graph()`, so it only ever shows files in the
folders it may read and that the person using it may read. It never writes.

A vault of 10,000 notes and 25,000 links opens in about a second on a laptop and stays smooth to
pan, zoom and drag: the layout is a Barnes-Hut force simulation that settles in a few seconds, and
a big picture is moved as an image while you pan or zoom. It is drawn on a 2D canvas, so labels are
limited to the best connected notes in view.

Strings are in English, Traditional Chinese and Simplified Chinese (`locales/`).
