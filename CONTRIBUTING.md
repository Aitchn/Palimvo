# Contributing to Palimvo

Thanks for helping out. Palimvo is pre-alpha, so the best first step is to open an issue and
discuss what you want to change.

## Setup

- Node 24 (`.nvmrc`) and pnpm 10 through Corepack: `corepack enable`.
- `pnpm install`

## Checks

All of these must pass before a pull request is merged, and CI runs them:

```sh
pnpm lint        # ESLint + Prettier check
pnpm typecheck
pnpm test
pnpm build
```

`pnpm format` rewrites files with Prettier.

## Workflow

1. Branch from `main`; one change per pull request.
2. Write commits and PR titles as [Conventional Commits](https://www.conventionalcommits.org/),
   for example `feat(server): add health endpoint`. Pull requests are squash-merged, so the PR
   title becomes the commit message.
3. If users can see the change, add a changeset: `pnpm changeset`. All packages share one version.
4. Significant design decisions get an ADR in `docs/adr/` (copy `0000-template.md`).
5. Code, comments, documentation, and ADRs are written in English. User-facing strings go through
   i18n once the `@palimvo/i18n` package is wired in.

## Licensing

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
