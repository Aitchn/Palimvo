# Palimvo

A self-hosted knowledge base where people and AIs write together, and every change is
accountable: who made it, why, and what it replaced.

Notes are plain Markdown, canvases are JSON Canvas, and databases are Obsidian Bases files, so a
vault opens in Obsidian as-is. Each vault is a git repository.

> **Status: pre-alpha.** The repository is being built up from scratch; nothing here is usable yet.

## Development

Requires Node 24 and pnpm 10 (via [Corepack](https://nodejs.org/api/corepack.html)).

```sh
corepack enable
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[Apache License 2.0](LICENSE)
