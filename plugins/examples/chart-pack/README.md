# Chart pack

More types for `component` blocks. Each takes its numbers from the block's YAML, or from values
the app resolved from note properties and databases. Charts follow light and dark.

````
```component
type: radar
title: Options
axes: [Speed, Cost, Safety, Fit]
series:
  - { name: Plan A, values: [4, 2, 5, 3] }
  - { name: Plan B, values: [3, 4, 3, 5] }
max: 5
```
````

| Type        | Options                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `radar`     | `axes` (3 or more), `series` (up to 8, each `name` + `values`), `max`, `title` |
| `treemap`   | `items`: `{ name, value, color?, children? }`, nested to any depth; `title`    |
| `sparkline` | `values`, `label`, `unit` (the last value is shown beside the line)            |

Values must be numbers; text that looks like a number is accepted, anything else counts as
missing. Tooltips on the shapes give the exact values.
