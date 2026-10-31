# Spec mode

Spec mode is a stricter precursor to plan mode. The agent can read the codebase and write exactly one artifact: the specification file.

## When to use it

- New features with non-obvious acceptance criteria
- Architectural changes that cross module boundaries
- API design where the contract matters more than the implementation
- Anything where "what 'done' looks like" should be committed to a file before coding starts

## What a good spec contains

1. **Problem statement** — one paragraph. What's wrong now, what changes, and why.
2. **Acceptance criteria** — bullet list. Each bullet is testable. "The user can X" / "System returns Y when Z".
3. **Test scenarios** — happy path + edge cases. Concrete inputs and expected outputs.
4. **Out-of-scope** — bullet list of things this spec explicitly does NOT cover. Prevents scope creep in implementation.
5. **Open questions** (optional) — unresolved decisions the user should answer before planning.

## Transitions

- `enter_spec_mode(task)` — start. Filesystem writes restricted to the `spec_path` it returns.
- `finalize_spec({ spec_body?, summary? })` — transition to plan mode once the spec is complete.
- `/noplan` — abandon spec mode (returns to act mode without finalizing).

## Rules

- Don't edit code in spec mode. The gating layer blocks it, but even if it didn't: the whole point is "write the contract first."
- Prefer bullets over paragraphs. A spec is a checklist, not an essay.
- If you don't have enough information to write the spec, ask the user. Don't guess.
