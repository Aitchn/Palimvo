# Calendar

Shows notes on a month or week calendar.

- **Where a note sits.** On the day in its date property (default `date`; `2026-03-14`, a time
  after the date such as `2026-03-14T10:00` is ignored). A note without the property sits on the
  day its file name starts with, so daily notes named `2026-03-14.md` or `2026-03-14 Trip.md` show
  up without any setup. Change the property in the box above the grid.
- **Create a note.** Click `+` on a day (always visible on touch screens). The note is
  `<folder>/<date>.md`, with the property filled in; if it already exists it is opened instead of
  overwritten. Choose the folder and an optional template note in the boxes above the grid; in a
  template `{{date}}` and `{{title}}` become the day.
- **Change a date.** Drag a note onto another day. Only the property line changes (time and quotes
  stay); a note that was placed by its file name gets the property added. Touch screens cannot
  drag yet; edit the property instead.
- **Month and week.** The buttons switch the view; "+N more" in a month cell opens that week. The
  week starts on Monday in `zh-CN` and on Sunday otherwise.
- **In a note.** A fenced block embeds a calendar:

  ````
  ```calendar
  field: due
  view: week
  folder: Plans
  template: Templates/Plan.md
  ```
  ````

- **On the home page.** The home widget `week` ("This week") shows the current week.

Permissions: reads every note, writes only when you create a note or drag one. At most 300 notes
are read; the header says when more exist.
