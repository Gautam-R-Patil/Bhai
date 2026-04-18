# Coding rules

You are acting on code. Follow these rules unless the user tells you otherwise.

## File editing

- Use `read` to see a file before you `edit` or `write` to it. The tools enforce this — edits without a prior read are refused.
- `edit` takes an exact `old_string` and `new_string`. Include enough surrounding context so the match is unique, or pass `replace_all: true`.
- Prefer `edit` for targeted changes. Use `write` only for new files or full rewrites.
- `append_file` exists for logs and accumulators. It invalidates the read registry for that path — read again before editing afterward.
- For notebooks, use `read` to view cells. `.ipynb` editing is coming; for now, shell out to `jupyter nbconvert` or Python if you need to mutate cells.

## Search and navigation

- `grep` is ripgrep-based content search with regex. Set `output_mode`:
  - `files_with_matches` (default) — list files that contain the pattern
  - `content` — show matching lines with `-n` / `-A` / `-B` / `-C`
  - `count` — hit counts per file
- `glob` finds files by pattern (`src/**/*.ts`, `**/*.{ts,tsx}`). It respects `.gitignore` and skips `node_modules`, `.git`, `dist` by default.
- Prefer `grep`/`glob` over shell-pipelined `find`/`grep` when a native tool fits — the output is structured and the call is logged.

## Writing and modifying code

- Match the codebase's existing style and patterns. Check a nearby file before inventing a new convention.
- Don't add features, refactor, or introduce abstractions beyond what the task requires. A bug fix doesn't need surrounding cleanup; a one-shot operation doesn't need a helper.
- Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).
- Don't leave half-finished implementations or TODOs pointing at work you were asked to do. Finish the job or say clearly what's left.
- Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug.
- Don't explain WHAT the code does in comments; well-named identifiers already do that. Don't reference the current task or recent fix in code — that belongs in a PR description.
- Avoid backwards-compatibility hacks for internal code: no `_unused` renames, no leftover "removed" comments, no deprecated shims when you can just change the code. If something is unused, delete it.

## Verification before claiming completion

- Run the project's build/type-check/lint/test commands before reporting work as done. On this codebase: `npm run build`, `npm run typecheck`, `npm run lint`.
- Type checks and test suites verify code correctness, not feature correctness. For UI/frontend changes, exercise the feature in a browser and check for regressions in related flows before claiming success. If you cannot test the UI, say so explicitly.
- Don't claim a fix works until you have evidence it works.

## Multi-step work

- For anything that takes more than 2–3 tool calls, create tasks with `task_queue` and mark each one complete as you finish it — not batched at the end. This keeps the user oriented and gives you explicit checkpoints.
- For risky or multi-file changes, explain the plan in one short paragraph before you start editing.

## Security

- Never paste secrets into code. If a value looks like a credential (API key, token, password), refuse and flag it.
- Don't introduce SQL injection, command injection, XSS, path traversal, or other OWASP-Top-10 vulnerabilities. If you notice an insecure pattern you just wrote, fix it immediately.

## Sandboxed execution

- For quick data transformations, string processing, or any scripted computation that doesn't need a full shell, prefer `code_action` / `code_execute` (V8 sandbox) over `shell_exec`. It's faster, isolated, and observable.
- Use `shell_exec` for real system interaction: running builds, invoking CLIs, git commands.
