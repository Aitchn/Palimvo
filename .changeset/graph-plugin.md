---
"@palimvo/web": minor
"@palimvo/server": minor
"@palimvo/plugin-sdk": minor
"@palimvo/core": patch
---

Official graph plugin: a page that draws the vault's links as a graph (colored by folder, tag or file type, with tag nodes, search and filters; 10,000 notes open in about a second) and a local graph in the details panel. Plugins get `palimvo.vault.graph()` and a new `inspector` slot, and `GET /graph` can add tags and return only the part around one file.
