# Kanban due dates

Adds a badge to every kanban card whose note has a `due` property (`YYYY-MM-DD`, a time after
the date is ignored): "Due today", "Due in 5 d", or "Overdue by 2 d". Red when overdue, amber
within three days, gray otherwise.

Needs the `kanban` plugin. It asks for no folder access of its own: the board hands it the
properties of the cards it shows. It is also the smallest example of the `card-badge` extension
point (see the Kanban README).
