# Contributing

Internal to XAGI Labs. Build commands and architecture are in `CLAUDE.md`.

## Workflow

1. Branch from `main`. `main` is protected: changes land through pull requests.
2. Open a pull request. CI runs typecheck and tests on Node 22 and 24 across
   Linux, macOS, and Windows, plus the native build, Rust quality, CodeQL, and
   dependency review.
3. A code owner approves; resolve every review conversation.
4. Squash-merge. The pull request title becomes the commit title, so write it as
   the change. The branch is deleted on merge.

## Lint

The codebase is only partly formatted. CI runs Biome on the files your pull
request changes, so format what you touch (`npx biome check --write <files>`)
rather than reformatting unrelated files.

## Releases

Release tags match `v*` and are protected: only admins create, move, or delete
them.
