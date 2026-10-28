## What changed

<!-- Describe the focused change. -->

## Why

<!-- State the user, safety, or maintenance outcome. -->

## Validation

- [ ] `npm run typecheck` and `npm run test:hermetic`
- [ ] `npx biome check` on the files I changed
- [ ] Native changes: `cargo fmt --check` and `cargo clippy -- -D warnings` in `native/`
- [ ] Tried it in the running app (desktop or channel) if a user would notice

## Checklist

- [ ] No secrets, tokens, customer data, or `.env` contents in the diff
- [ ] Convex changes deployed or noted (`npx convex deploy`)
- [ ] Server prompt changes reseeded or noted (`scripts/seed-system-content.ts`)
- [ ] New `ATLAS_*` kill switches documented in `CLAUDE.md`
