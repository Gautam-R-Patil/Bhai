I'll produce the unified roadmap directly. This is a synthesis task over an already-verified analysis, so I'll write the final document now.

# A.T.L.A.S × Hermes — Unified Capability Roadmap

## 1. Executive Summary

Hermes is genuinely ahead in three structural areas: **durability** (a SQLite task spine with CAS claims, crash-grace reclaim, and persistent circuit breakers vs. ATLAS's in-memory mesh/swarm state that evaporates on restart), **inbound interoperability** (it can be *driven* — ACP stdio server for Zed/Cursor, inbound MCP server exposing conversations — while ATLAS is strictly outbound A2A + MCP-client), and **safety-as-infrastructure** (transparent pre-mutation filesystem checkpoints, untrusted-tool-result fencing, a centralized SSRF/threat-pattern library, OS-malware pre-checks). It also has cleaner *seams*: pluggable provider ABCs, a manifest-driven plugin loader, and a unified platform-adapter contract where ATLAS hand-wires six bespoke channel modules. ATLAS is already ahead — and must not regress — on the **model layer** (zero client-side keys, E2E-encrypted Convex proxy, native Rust cost-router with a staggered-cooldown circuit breaker), **dynamic-tool reliability** (the Skill Forge: lookup→synthesize→verify→OS-kernel-sandbox is materially beyond anything Hermes ships), **on-device perception** (a confidence-gated AX/OmniParser/UI-TARS cascade with capability-tiered profiles), and **memory depth** (HNSW + KG + value-gate + dream-replay vs. a 7-method provider ABC). The through-line: **Hermes invested in the boring, load-bearing substrate — durable state, correlation IDs, defensive boundaries, swappable seams — while ATLAS invested in the intelligent layer — routing, memory, perception, synthesis.** The highest-leverage work is therefore not copying Hermes's intelligence (ATLAS is ahead there) but importing its **discipline**: fix the prompt-cache prefix bug, add pre-mutation checkpoints, fence untrusted tool results, centralize SSRF, give the task layer a durable spine, and open one inbound protocol. Several "novel" Hermes findings are already present in ATLAS in stronger form (offload-to-disk, code-action execution, OS-kernel sandbox, hook bus, server-side cache breakpoints) and must be defended in review rather than rebuilt.

A recurring sub-theme worth calling out: **a cluster of small bugs share one root cause** — volatile per-request content (the `[SYSTEM CLOCK]` at `messages[1]`, the iter-1 `fencedInjection`) sitting ahead of the Anthropic history cache breakpoint. Fixing that one ordering issue improves caching for goal-loops, background review, and every multi-iteration Heavy/Pro turn at once.

---

## 2. Tier 1 — High-Leverage, Do-First

Ordered by impact/effort.

### 1.1 — Prompt-cache prefix fix (volatile clock busts the history breakpoint)
**Effort: S · Impact: Medium-High (cost on every Opus/Sonnet turn)**

**What:** `src/llm.ts:171–181` injects a per-request `[SYSTEM CLOCK: <timestamp-to-the-second>]` block as `allMessages[1]`. After `convex/http.ts:614` unshifts the server prompt to `messages[0]`, that volatile block sits *inside* the always-cached history prefix, so the `messages.length-2` history breakpoint (`http.ts:666`) is busted on the first model call of every user turn. Non-Anthropic models skip breakpoints entirely, so this only bleeds the Opus/Sonnet tiers — but those are the expensive ones.

**Change:** Round the clock to a coarse bucket (date, or hour) in `src/llm.ts:172` so the block is byte-stable within a session (smallest diff), **or** move `dynamicContext` to the *end* of the message array (after the last user/tool message) with no breakpoint (preserves clock recency salience). Also fixes the `systemPromptOverride` merge path (`http.ts:583–590`) which folds the same volatile clock into `messages[0]` for sub-agent/classifier calls.

**Verify:** `cachedTokens` in `convex/llmCallLog.ts:25,40` should jump from ~0 to >0 on the 2nd+ iteration of an Anthropic tool loop.

> Note: a separate verified finding flags the iter-1 `fencedInjection` (`agent.ts:1262/2054–2065`) as a *second* volatile-prefix offender on turn-1 specifically. The structured pass confirms `fencedInjection` is gated to `iterations===1` and lives only in the transient `iterationMessages` array (so iters 2+ within a turn are fine), but turn-1 of each exchange still can't hit breakpoint #3. Bundle both fixes: bucket the clock **and** relocate `fencedInjection` to sit after history. One PR, one root cause.

### 1.2 — Untrusted-tool-result delimiter fencing (indirect prompt-injection defense)
**Effort: S · Impact: High**

**What:** Web/browser/MCP tool results reach the model with zero "this is DATA not instructions" framing. ATLAS already ships the exact wrapper *pattern* for memory (`src/context-scrubber.ts::fenceMemoryContext`) — it just never applies it to tool output. Both tool-message assembly sites push `r.finalContent` verbatim (`src/agent.ts:2789–2793`, `:3045–3050`).

**Change:** Add `wrapUntrustedToolResult(toolName, content)` mirroring `fenceMemoryContext`'s wording + idempotency check. Gate on `{web_search, web_fetch, web_extract, deep_research, gitmcp_docs}` + prefixes `browser_`/`mcp_`/`research_`, 32-char floor, re-entrancy guard. Apply it inside `executeAndProcessToolCall` *after* offload/truncate (≈ line 676, on the string `result`) so both push sites and the sub-agent path are covered in one place. **Before** wrapping, run external content through the existing `sanitizeUntrustedContent` to strip attacker-injected `<untrusted_tool_result>`/`<system-reminder>` tags (delimiter-spoofing defense). Add an MCP-result scrub at `src/mcp/client.ts:209` (currently raw `JSON.stringify`). Add a one-line note to the server-side `rules` prompt so the model knows the delimiter's meaning (parallels `SYSTEM_REMINDER_EXPLANATION`). Gate `ATLAS_NO_UNTRUSTED_WRAP` (default ON).

**Do NOT** blindly run `sanitizeMessageHistory()` over all tool results — it would strip ATLAS's own trusted `<system-reminder>` tags injected at `agent.ts:2266–2274`.

### 1.3 — Centralized SSRF / metadata-floor URL guard (shared across all URL tools)
**Effort: M · Impact: High**

**What:** ATLAS has two partial, non-shared SSRF guards (`web-asset-download.ts::assertPublicHost`, `forge/capabilities.ts::isPrivateOrLoopbackIp`), and **two unprotected attacker-URL fetch paths**: `src/research/fetcher.ts` (bare `fetch` on attacker-supplied URLs) and the WhatsApp link-preview path (explicitly disabled with a comment requesting a guard).

**Change:** Promote `assertPublicHost` into `src/security/url-safety.ts` exporting `isSafeUrl(url)` (scheme allowlist + per-resolved-address private/loopback/link-local/CGNAT check, fail-closed on DNS error) and `isAlwaysBlockedUrl(url)` (non-negotiable cloud-metadata floor: 169.254.169.254/170.2/169.253, 100.100.100.200, `fd00:ec2::254`, `::ffff:` mapped variants, hostnames `metadata.google.internal`/`metadata.goog`/`instance-data`/`metadata.azure.com` — blocked even under any allow-private escape hatch). Move the existing `MAX_HOPS` redirect-revalidation loop into the shared module. **Wire it** (the actual fix): call `isSafeUrl` in `research/fetcher.ts::fetchPageContentOnce` (highest value), gate-then-re-enable the WhatsApp preview, and delegate from `web-asset-download.ts` + `forge/capabilities.ts` to kill duplication. Add a parity/regression vitest mirroring `forge/sandbox-hardening.test.ts`.

### 1.4 — Transparent pre-mutation filesystem checkpoints (shadow-git store)
**Effort: L · Impact: High**

**What:** ATLAS's only rollback is the LLM-visible, ephemeral, repo-only `git_op checkpoint` (`git stash create`, GC-eligible). `edit.ts`/`write.ts`/`append-file.ts` mutate after only permission gates — no snapshot, no recovery in non-git dirs.

**Change:** Port a TS `CheckpointManager` into `src/tools/coding/` (next to `git-op.ts`). Use `execFileSync('git', ...)` with env-isolated `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` pointing at a shared shadow store under `getWorkspaceSubdir('.atlas-checkpoints')`, so the user's project `.git` is never touched and non-git dirs are still protected. Wire `ensureCheckpoint(dir, reason)` as a `BUILTIN_HOOKS.PreToolUse` entry matching `^(edit|write|append-file)$` (returns `{}`, never blocks — pure side-effect), co-located with the existing LSP-pre-edit hook (`src/hooks/built-in.ts:196`). Dedup to one snapshot per dir per agent turn. Port Hermes's exclude list (node_modules/.env/media/binaries), 10MB/file + 500MB-store caps, orphan-ref prune + `git gc`, and the **pre-rollback safety snapshot** in `restore` (undo-the-undo). Reuse `codebase-merkle.ts:56` hashing for the per-project ref. Default-ON for coding contexts behind `ATLAS_NO_AUTO_CHECKPOINT` (safety win, not a perf bet). The cross-worktree shared-store dedup specifically benefits the `ATLAS_AGENT_WORKTREE=true` path. Surface `/checkpoints status|prune|clear`.

> This is git-as-storage via `execFileSync` — explicitly NOT the SHA-NI/hardware-crypto loser case from the Rust empirical lessons. No Rust, no Convex.

### 1.5 — `session_search` tool over raw-transcript FTS5 (zero-LLM recall)
**Effort: L · Impact: High**

**What:** `conversations.messages_json` is write-only — written by `reflection.ts:127` (`slice(-20)`), never read for retrieval. `recallConversation` returns only the `summary` field. There's no agent-facing "what did we decide / where did we leave X" recall.

**Change (staged):**
1. **Fix the corpus first** (often missed): `messages_json` captures only the last 20 messages at reflection time, so exact recall is truncated for long sessions. Persist full history (or per-turn rows) and/or write incrementally, not only at reflection.
2. Add a `conversations_fts` FTS5 virtual table (+ trigram variant for CJK) over per-message content, reusing `sanitizeFts5Query`/`buildTrigramQuery` from `src/memory/fts5-query.ts`. Either decompose into per-message rows (enables Hermes-style id anchoring) or anchor by array-index within a session row (simpler — ATLAS has no `parent_session_id`).
3. Add a single-shape `session_search` tool: `discovery=query` → FTS5 snippet + ±N window + first/last-3 bookends; `scroll=session_id+anchor` ([1,20] clamp); `browse=recent sessions`. Returns *actual stored messages* at zero LLM cost. Drop Hermes's session-lineage/dedup machinery (no child sessions in ATLAS).

Keep `recallConversation`'s summary path for the cheap first-iter briefing.

### 1.6 — Per-turn tool-call loop guardrail (identical-args / same-tool-failure detection)
**Effort: M · Impact: High**

**What:** ATLAS's three loop guards (whole-batch no-progress, circuit-breaker, metacognition) all key on tool *name* or whole-batch output — none on tool *arguments*. A single tool retrying identical args while other tools succeed is invisible.

**Change:** Add `src/agents/tool-call-guardrail.ts`: per-turn `Map` keyed by `${fnName}:${sha256(canonicalSortedJson(fnArgs))}` counting failures + a same-tool counter + an idempotent-result-repeat counter (read-only set drawn from `PLAN_MODE_ALLOWED_TOOLS`). Reset at top of each turn. Wire into the existing tool-result loop at `agent.ts:3061–3069` (where `updateSignals` already has `fnArgs` in scope — `recordToolCallForVerifyGate` at `:2982` proves it). **Warn-only default:** on ≥2 identical failures, append a tool-specific recovery hint (mirror Hermes `_tool_failure_recovery_hint`). Hard-stop opt-in via `ATLAS_TOOL_LOOP_HARDSTOP` (≥5 → synthetic error, skip the call). `sha256` via `node:crypto`; canonicalization can reuse `canonicalToolJson` (`create-tool.ts:99`). Composes with — does not replace — the existing no-progress guard.

### 1.7 — Skill Curator: usage-driven staleness + LLM umbrella-consolidation
**Effort: L · Impact: High**

**What:** No cross-skill umbrella consolidation, no skill/addenda lifecycle. The server-side `user_prompt_addenda` table already has `isActive`, `deactivateAddendum` mutation, a live `/api/user/addendum/deactivate` route, version history (`user_prompt_addendum_history`), AND a `hits` field + `incrementHits` mutation that is **never called**.

**Change:** Add nightly `src/proactive/skill-curator.ts` after `runSelfImprovementSynthesis` in `dreaming.ts:~241`, gated `ATLAS_NO_SKILL_CURATOR`.
- **Phase 1 (pure):** First wire the missing usage signal — call `incrementHits` when the server assembler reads addenda (`systemContent.ts:283`), or add `lastUsedAt`. Then time-based active→stale→archived (30/90 days) via the existing `deactivateAddendum` route (no new Convex work — archival = `isActive=false`, recoverable).
- **Phase 2 (LLM):** Reuse `fetchCurrentAddenda` to list active `skill-*` addenda, cluster by slug-prefix/embedding, and for clusters of 2+ ask Sonnet (matching `synthesizeMergedContent`) for an umbrella + deprecate-list; upsert umbrella, deactivate siblings. Adopt Hermes's 3-signal reconciler (`absorbed_into` > structured-YAML > tool-call substring audit) to guard against hallucinated umbrellas.

Do NOT touch `consolidation.ts`/`self-evolving.ts` (different object class). Optionally fold the dormant Forge `invocationCount`/decay path in as a sub-task.

### 1.8 — Durable SQLite task spine (CAS claim + TTL + heartbeat liveness)
**Effort: L · Impact: High**

**What:** Orchestration is fully in-process. `long-task.ts` writes whole-object JSON checkpoints (no PID, no `last_heartbeat_at`, no liveness gate); `mesh.ts` keeps results in memory. A crash silently abandons in-flight swarm/mesh work.

**Change:** Add a `data/tasks.db` sidecar (separate from `memories.db`, raw `better-sqlite3` via the `getRawSidecar()` pattern, NOT the wrapped helper). Tables `tasks(id, status, assignee_role, claim_lock, claim_expires, consecutive_failures, last_heartbeat_at, worker_pid, current_run_id, model_override, depends_on)` + `task_runs` + `task_events`. PRAGMAs `synchronous=FULL`/`foreign_keys=ON`/`busy_timeout`. Claim via atomic CAS (`UPDATE ... WHERE id=? AND status='ready' AND claim_lock IS NULL`; rowcount==1 wins). Stale-claim sweep that *extends* the claim when `worker_pid` is host-local-alive AND `last_heartbeat_at` is fresh, with a heartbeat-staleness backstop. **Stage it:** first back `long-task.ts` phases with task rows (have the existing 60s `HEARTBEAT_CHECKPOINT_MS` timer bump `last_heartbeat_at` instead of rewriting the whole JSON); then back `mesh.ts`'s checkpoint with `task_runs` rows. Keep execution in-process. Gate `ATLAS_DURABLE_TASKS`, fail-open to current JSON/mesh paths.

This is the substrate for the durable circuit breaker (2.x), per-task model overrides (2.x), and the eventual kanban board (Tier 3 / future).

### 1.9 — OSV malware (MAL-*) pre-install check for npx/uvx MCP packages
**Effort: S · Impact: Medium**

**What:** No package/dependency known-malware check anywhere. Project-level `mcp-servers.json` npx/uvx servers and the local npm-install tree get no advisory lookup.

**Change:** Add `src/security/osv-check.ts::checkPackageForMalware(command, args)` — infer npm from npx, PyPI from uvx/pipx, parse pkg name+version (handle `@scope/name@ver`, `name==ver[extras]`), POST `api.osv.dev/v1/query`, filter to `id.startsWith('MAL-')` only (near-zero FP), return BLOCK with ≤3 advisory ids, fail-open on network/parse error, 10s timeout. Wire at `src/mcp/client.ts::connectServer` before `StdioClientTransport` (the npx/uvx idiom — the clean primary target). Gate `ATLAS_NO_OSV_CHECK` (default ON). The store path uses `node dist/index.js`, so a single pkg@ver parse misses it — defer a lockfile-based `querybatch` audit in `installer.ts` to a follow-up; ship the MCP-launch check first.

---

## 3. Tier 2 — Strong Additions

### 2.1 — Structured 13-section compression template + iterative update
**Effort: M · Impact: Medium**

`context-pruning.ts:182–191` uses a one-line generic summarizer prompt. Port a structured template (Active Task *verbatim*, Goal, Completed Actions [numbered, with tool names], Active State [cwd/branch/modified files/test status from `git_op`+`lsp`], Blocked [exact error text], Key Decisions, Pending User Asks, Relevant Files, Remaining Work). Add an iterative-update branch: persist the last summary on the session (reuse `session.ts` state + `current_goal` for Active-Task) so the next prune continues numbering and migrates In-Progress→Completed instead of re-summarizing cold. Run `sanitizeSecrets()` over the output. Add the `--- END OF CONTEXT SUMMARY ---` marker. **Keep `role:system`** (ATLAS's leakage-prevention invariant; cache is handled server-side). Wire `focus_topic` only via the manual `/compact <topic>` path.

### 2.2 — Cheap no-LLM pre-compression pass (dedup + arg-truncation + media strip)
**Effort: M · Impact: Medium**

Add a free pre-pass to `compressToolHistory` before any summarization: (1) hash tool-result content (`sha256`, first 12 hex) walking backward, replace older dupes with a back-reference; (2) for assistant messages outside the protected tail, `JSON.parse` `tool_calls[].function.arguments` and truncate long string values in-place (reuse `smart-truncate.ts::pruneJsonValues` — keep valid JSON so providers don't 400); (3) replace the flat 500-char tool-response cut with `smartTruncate(toolName, content)`; (4) strip historical `image_url` base64 blocks (outside the tail) to a text placeholder. Optionally switch the tail boundary from fixed-20 to a token budget via the already-present `estimateMessagesTokens`. All LLM-free, reuses existing code, zero Convex/native.

### 2.3 — Per-model context-window awareness
**Effort: M · Impact: High**

`ModelInfo` (`native/src/model_router.rs:41–54`) has only `max_tokens` (output). `pruneContext` triggers on message *count*; `estimateMessagesTokens` is dead code. Add a static `context_window: u32` to the Rust registry (one value per model — Opus/Gemini ~1M, Haiku/GLM 200K, GPT-5 ~400K, Nova ~300K, DeepSeek ~128–160K). **Do NOT** port Hermes's 10-stage resolution chain / models.dev / probe tiers — ATLAS's fixed proxied registry makes them dead weight. Expose `getContextWindow(modelId)` via napi. Consumers: (1) switch `pruneContext` to an estimated-tokens-vs-window ratio (prune at >~0.7 × window); (2) guard `getHorizontalFailoverModel` to exclude/de-prioritize candidates whose window < current token estimate (closes the unguarded 1M→200K hop). Opt-IN `ATLAS_WINDOW_AWARE_PRUNE` + parity test, then flip default after bench.

### 2.4 — Durable circuit breaker (depends on 1.8)
**Effort: M · Impact: High**

`circuit-breaker.ts` is per-run and in-memory; durable stores have no failure counter. Extend the task spine (1.8) with `consecutive_failures` + `last_failure_error` + blocked-state columns. Reuse the *existing* `circuit-breaker.ts` semantics (reset-only-on-progress) but back the counter with the durable column. Centralize `recordTaskFailure(taskId, outcome)` (increment, flip to `blocked` at limit; default 2 to match Hermes) and `recordTaskSuccess` (reset to 0). Port two Hermes invariants ATLAS lacks even in-memory: **no reset on successful spawn** (only on genuine completion), and **protocol-violation** (clean rc=0 exit without completing) trips on first occurrence. Surface `gave_up` to `proactive/trigger-detector.ts` so it stops re-firing every 30-min cooldown — that's the actual credit-burn fix.

### 2.5 — `@`-inline context references (`@file:path:lines`, `@diff`, `@url`, ...)
**Effort: M · Impact: Medium**

Add a pre-agent message preprocessor (in `runAgent` before iteration 1, uniform across channels) that parses `@file:path:lines / @folder / @diff / @staged / @git:N / @url`. Expand via existing internals: files through `src/tools/files.ts`, git via `git-op.ts`, URLs via the web/browser extract path. Sandbox path resolution to `getWorkspaceDir()`; layer a credential blocklist (reuse `allowlist.ts` patterns) and run expansions through `secrets-sanitizer.ts`. Enforce a token budget vs. the model context window (soft-warn 25% / hard-refuse 50%). Append under one `--- Attached Context ---` block, strip `@tokens` from prose. Accelerates the coding/power-user path. (Cache benefit is partly negated by 1.1 — fix that first.)

### 2.6 — API-error classifier (Convex-proxy-aware, ~3 branches)
**Effort: M · Impact: Medium**

ATLAS classifies on raw HTTP status only and never parses the upstream message it already receives. Add a small `src/llm/api-error-classifier.ts` (TS enum + interface, reusing the keyword-list pattern from `error-types.ts`). In `llm.ts`'s catch block: **context_overflow** → `pruneContext` once and retry SAME model before falling back; **rate_limit/overloaded** → jittered backoff then same model; **content_policy/format_error (400)** → mark non-retryable, skip straight past the fallback chain (don't burn 3 paid attempts re-sending a deterministic refusal). Parse `errData.error.message` + OpenRouter's nested `metadata.raw`. **Explicitly drop** credential rotation (no client keys) and ~15 provider-SDK reasons (single gateway). Keep keyword lists data-driven.

### 2.7 — `no_agent` + pre-run-script cron jobs (zero-LLM watchdog + wake-gate)
**Effort: M · Impact: High**

ATLAS cron always spends tokens — every fire calls `runAgent`. Add optional `script?: string` + `noAgent?: boolean` to `CronJob` (`src/cron/store.ts`), `AddJobInput`, and the cron-tool schema (owner-gated). In `runCronTick`:
- **`noAgent`:** resolve script under `data/cron-scripts/` with a path-traversal guard, validate via `allowlist.ts::isCommandAllowed` (NOT `sandbox.ts`), spawn with timeout, `sanitizeSecrets` over stdout. Non-empty stdout → deliver verbatim; empty → silent success; non-zero/timeout → error alert. Reject `noAgent` without a script at create time.
- **`script` + `!noAgent` (wake-gate):** run script once, parse last stdout line — `{wakeAgent:false}` → skip `runAgent`, mark success; else prepend stdout as `## Script Output` (or `## Script Error`) to `job.prompt`.

For arbitrary user code on a 60s ticker, prefer routing through the Forge kernel-sandbox or Docker isolation over bare `exec`. Gate `ATLAS_NO_CRON_SCRIPTS`. (Ship `no_agent` and the wake-gate together — same `script` field.)

### 2.8 — `skipMemoryWrite` flag for cron/autonomous runs
**Effort: S · Impact: Medium**

Cron runs share the global `conversationHistory`, increment session `turn_count`, append turns, and are eligible for `runReflection` — polluting user/relationship/episodic representations as if the owner had a conversation. Add `isAutonomousRun`/`skipMemoryWrite` to `ChannelContext` (`agent.ts:353`), set true at the cron call site (`index.ts:1025`). When set: skip `touchSession` increment + `appendTurn`, make `maybeReflect` a no-op (`&& !isAutonomousRun`), skip the session-expiry `runReflection` (`agent.ts:1302`). Keep identity/core-memory READS and `saveStrategy` (task-skill, not relationship). Mirrors Hermes `load_soul_identity=True` + `skip_memory=True`. Add a regression test asserting `relationship_state.last_interaction` and `turn_count` are unchanged after a cron run.

### 2.9 — Concurrent-tool-batch path-overlap + destructive guard
**Effort: S · Impact: Medium**

The main-agent parallel batch (`Promise.all` at `agent.ts:737`) partitions strictly by tool *name* with no write-collision guard. Add `shouldParallelizeBatch(toolCalls)` immediately before it: parse args, `path.resolve` the target for path-bearing tools (`edit`, `write`, `append_file`, `notebook_edit`, `read` — no `delete_file` tool exists), reserve them; if two normalized paths overlap as prefix-subtrees, OR a `shell_exec` command matches a destructive pattern (**reuse** existing `allowlist.ts::isSystemDestructive` / `tool-intelligence.ts::DESTRUCTIVE_ACTIONS` / `git-op.ts::classifyTier` — do NOT re-port Hermes's regex), run THAT batch sequentially (still awaited in order). Keep `BROWSER_TOOLS` sequential. Small TS path-overlap helper (not worth a Rust port). Leave `sub-agent.ts` alone (already sequential). Cover with a vitest firing two edits at the same path in one batch.

### 2.10 — Standing-goal Ralph loop (`/goal`) with LLM judge + turn budget
**Effort: L · Impact: Medium**

No user-facing "keep working on THIS until done" primitive. Build `src/goals/standing-goal.ts`: `GoalState` persisted to `memories.db` (mirror `goals.ts`), a `judge()` on the cost-router Light tier returning strict `{done, reason}` (reuse `evaluator.ts` JSON-extract + the `long-task.ts::replanPhases` fail-open-to-continue template). On CONTINUE, re-enter `runAgent` with a continuation **user** message (NOT a system block — preserves the cache breakpoints; mirror the proven `research/index.ts:251` re-feed). Turn budget (~20) auto-pause, 3-consecutive-parse-failure auto-pause, fail-open. Fold `/subgoal` criteria into both continuation and judge (evidence-per-criterion). Real user messages preempt (hook the channel command-parse pre-`runAgent`). `/goal pause|resume|clear` in `src/commands/index.ts`. Gate `ATLAS_NO_GOAL_LOOP` (opt-in first).

### 2.11 — `delegate_tasks` first-class parallel-fan-out tool
**Effort: M · Impact: Medium**

`swarm_task` always forces an LLM auto-decompose. Add a sibling `delegate_tasks({ tasks: [{goal, context?, role, tool_categories?}] })` that bypasses `decompose()` and builds a dependency-free wave directly — construct `SubAgentTask[]` (which already honors `context` and `role→ROLE_TOOLS`) and run via `Promise.all` over `runSubAgent`. Gate per-task `tool_categories` through the tool-router category map (not raw names). Keep `swarm_task` for genuine auto-decompose; justify this on latency (skips the decompose LLM call) + determinism.

### 2.12 — Rate-limit header tracking + in-process breaker
**Effort: M · Impact: Medium**

ATLAS reads no provider rate-limit headers; `convex/http.ts` drops `x-ratelimit-*`/`Retry-After` on both success and 429. (1) `convex/http.ts`: forward the `x-ratelimit-*` suite + `Retry-After` to the client. (2) Client `src/llm.ts`: parse into a tracker (port `rate_limit_tracker.py` bucket math) + an in-memory shared breaker keyed by provider/model, persisting `reset_at` to `data/rate-limits.json` for cross-restart survival (drop Hermes's multi-process file-locking — ATLAS is single-process). Wire the breaker into the fallback loop (`llm.ts:236`, next to the circuit-breaker skip). (3) Keep Hermes's **is-genuine distinction** (account-bucket-exhausted → trip; single-model-transient → swap model, don't trip) — the valuable insight that stops one busy model blackholing the shared key. (4) Consume `ErrorCategory.ResourceLimit` in `error-recovery.ts` to honor `reset_at`. Extend `/usage` to show "resets in Nm".

### 2.13 — ShareGPT trajectory recorder (opt-in)
**Effort: M · Impact: Medium (latent until a consumer exists)**

`workingHistory` is a full OpenAI-format array at end of `runAgent` but is never serialized. Add `src/memory/trajectory-export.ts::serializeTrajectory(workingHistory, userQuery, completed)` (OpenAI→ShareGPT is near-direct), wired at the end-of-turn `finalizeTrace`/`consumeOnePending` site (`agent.ts:~2928`), behind `ATLAS_SAVE_TRAJECTORIES` (default off). Read the dead `messages_json` as a secondary source. Write to `data/trajectories/{completed,failed}/<sessionId>.jsonl`; split on run outcome; redact via `secrets-sanitizer`; normalize image-bearing results to text summaries. **Defer** the 1508-LOC compressor (`trajectory_compressor.py`) — only needed once there's a concrete fine-tune/distill/eval target. Frame near-term payoff as replay/debugging + offline eval corpus.

### 2.14 — Smart-approval normalization + working soft-confirm
**Effort: M · Impact: Medium**

ATLAS already has an unconditional destructive floor (no yolo mode), but: (1) no ANSI/NFKC/null-byte normalization before regex matching (raw-byte bypass), and (2) `requiresConfirmation` is a **no-op** — its caller (`src/tools/index.ts:729–734`) only `console.log`s. Fix both: add `normalizeCommandForDetection(cmd)` (strip ECMA-48 ANSI, NFKC, drop nulls) inside `isSystemDestructive`/`isShellBypass`/`requiresConfirmation` before any regex (pure correctness hardening — CLAUDE.md exempts safety wins from measure-first). Broaden patterns toward ATLAS's threat model (curl|wget pipe-to-sh, recursive chmod 777, `kill -9 -1`, self-termination via `$(pgrep …)` targeting the node/atlas process). **Fix the no-op**: inject `warningMessage` into the returned tool result. Optionally, behind `ATLAS_SMART_APPROVAL` (off), add a Haiku temp-0/16-token APPROVE/DENY/ESCALATE arbiter for confirm-tier false positives + a consent-contract BLOCKED message.

### 2.15 — Centralized threat-pattern library (memory + context scanning)
**Effort: L · Impact: High**

No centralized prompt-injection/promptware/C2/exfil scanner. `value-gate.ts` admits/rejects on usefulness, never threat; context files (AGENTS.md/repo_map/architecture) are injected unscanned. Port `threat_patterns.py` → `src/security/threat-patterns.ts` with three scopes (all/context/strict), filler-word-resistant regexes, and a frozenset of 17 invisible/bidi unicode chars (set-intersection). Wire `scope='strict'` into `value-gate.ts` as an injection-reject branch (shadow-log to `data/memory-gate.jsonl` first, reuse `ATLAS_MEMORY_GATE_SHADOW`); wire `scope='context'` into the `agent.ts:1374–1409` repo_map/architecture injection (block-with-placeholder). Build TS-first; only consider a native port after a bench win + parity test (the invisible-char per-char scan likely loses to FFI tax — keep it TS).

### 2.16 — Child-process credential stripping (agent shell only)
**Effort: M · Impact: Medium**

`shell.ts::execCommand` and `code-critic.ts:133` inherit full `process.env` (incl. `GITHUB_TOKEN`, `EMAIL_PASSWORD`, channel tokens, voice keys). Pass an explicit env: clone `process.env`, delete a `SECRET_ENV_NAMES` blocklist (+ regex `/SECRET|TOKEN|PASSWORD|API_?KEY|CREDENTIAL|ACCESS_KEY|REFRESH/`). Reuse the skill-frontmatter pattern for a session-scoped opt-back-in allowlist. Patch `code-critic.ts:133` to the scrubbed env. **Leave Forge untouched** — `native/src/forge_sandbox/{macos,linux}.rs` already `.env_clear()` + selectively re-admit; it's the reference impl, not a gap. Gate `ATLAS_NO_SHELL_ENV_SCRUB` (default ON). Note the genuinely-unmitigated vector is same-line network exfil (output redaction already covers `printenv` dumps). Regression test: `printenv | grep TOKEN` returns nothing for blocklisted vars.

### 2.17 — Inbound MCP server (`atlas mcp serve`)
**Effort: L · Impact: High**

ATLAS is MCP client-only; `@modelcontextprotocol/sdk ^1.9.0` (server half) is already a dependency. **Phase 1 (S-M):** expose `messages_send` (→ `send_message_on_channel`/`channelSenders`) + `channels_list` — these map cleanly. **Phase 2 (L, the real work):** the read+wait surface (`conversations_list/get`, `messages_read`, `events_poll/wait`) requires a **new unified cross-channel conversation+event index** — `session.ts` is one rolling session and per-channel history is scattered. Hook `events_wait` to `globalInboxBus` for proactive events; inbound-message events need a new emitter. Auth via the existing A2A token model (`authorizeA2A` constant-time bearer, default-deny, 127.0.0.1 hardening). Gate `ATLAS_NO_MCP_SERVE`. Do not represent Phase 2 as "just an adapter."

### 2.18 — Pre-execution edit approval (sensitive-path always-confirm + overlay diff)
**Effort: M · Impact: High**

Split into two independent pieces, decoupled from ACP:
- **Piece 1 (do first):** `allowlist.ts` has NO entry for `~/.ssh`, `.env*`, `id_rsa`, `id_ed25519`, `.git` internals, `.aws/credentials`, `.npmrc`, `.pem/.key` — these are writable. Add `SENSITIVE_NAMES` + `isSensitivePath(filePath)` (symlink-aware via existing `realResolve()`); `edit.ts`/`write.ts` refuse unless an explicit confirmation token is present, regardless of plan-mode state. Single source of truth in `allowlist.ts`.
- **Piece 2 (overlay-scoped):** reuse `buildDiffPreview()`, add an overlay WS message type (extend the inbox approve/edit flow) to render the diff for approve/deny. Per-session policy toggle (`ask`/`accept_edits`=auto-allow under workspace root/`dont_ask`) in `plan-mode.ts` — but sensitive paths from Piece 1 always re-ask. Don't attempt synchronous 60s blocking round-trips over Telegram/WhatsApp; fall back to Piece 1's hard refuse there.

### 2.19 — Generalized MCP OAuth + HTTP/SSE transport
**Effort: L · Impact: High**

Remote MCP servers can't connect (`StdioClientTransport` only). The SDK already provides `StreamableHTTPClientTransport`, `SSEClientTransport`, and a full `OAuthClientProvider` (PKCE, metadata discovery, dynamic registration). (1) Choose transport by config (`url` → HTTP/SSE). (2) Implement `OAuthClientProvider` backed by `~/.atlas/mcp-tokens/<safe-name>.json`; wire `redirectToAuthorization` to a **shared loopback helper** — promote the near-generic `marketing/credential-setup/oauth-callback.ts` to `src/auth/oauth-loopback.ts` and have `google-api.ts` + the MCP provider both consume it (kills 3 duplicated loopback servers). The SDK's transport already does attempt→refresh→redirect, so most of `mcp_oauth.py` is unnecessary. (3) Optional/lower-priority: Hermes's two novel bits — mtime re-check before forced re-auth (external/cron refresh), and per-`(server,access_token)` in-flight promise to dedup concurrent 401s.

### 2.20 — Full per-turn trajectory span tree (observability)
**Effort: L · Impact: High**

`audit.jsonl` (args, no results, no correlation id) and `llmCallLog` (cost only) are two disjoint flat stores. Mint a `turnId` at the top of `runAgent`, thread it through the tool-exec wrapper (`src/tools/index.ts`) and LLM middleware so both carry the same key. Extend tool `auditLog` to record the truncated **result** (reuse `smart-truncate.ts` + Hermes's read_file head/tail + base64-elision). Assemble root turn span → LLM-generation children (reuse `llm_call_log` token fields + `convex/credit_cost.ts` per-token-type cost) → tool children (args+result+`durationMs`). Persist to `data/trajectories/<sessionId>/<turn>.json` (gitignored). Optional thin OTel/Langfuse exporter behind `ATLAS_TRACE_EXPORT` (off, fail-open, guard placeholder keys). Substrate for both the debug view and the future RL/eval pipeline.

### 2.21 — Persistent forkable session store
**Effort: L · Impact: High**

`session.ts` resumes only the most-recent session within 30 min (summary + last 6 turns, 500-char-truncated), keyed off a module-global `currentSession`. Generalize to an id-keyed `SessionManager` (`Map<sessionId, SessionState>` + the existing `sessions`/`conversations` tables as durable store): `getSession(id)` with restore-on-miss (read `messages_json` + a new `model_config` JSON blob), `fork(sessionId)` deep-copy, `listSessions()` merged + sorted. Wire channels to create/look-up by `(platform, chatId)`. Drop the 30-min timeout for explicit-id lookups. **This single change unblocks 2.17 (MCP-serve), the ACP server, and restart-durable per-thread channel history** (kills the cross-chat bleed where two Telegram chats + Discord + Slack + overlay collide in one 200-message buffer).

---

## 4. Tier 3 — Opportunistic / Small Wins

- **Jittered backoff in `error-recovery.ts:151` (S).** One-line change: `const base = p.backoffMs * Math.pow(2, attempt); const backoff = base + Math.random() * 0.5 * base;`. Decorrelates parallel sub-agent recoveries. Do NOT touch `llm.ts` (the native staggered-cooldown breaker is superior there) and don't add a new util — in-process `Math.random()` suffices (single event loop, not OS processes).
- **Broader secret redaction patterns (S).** Add DB-connstring-password (`(?:postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp)://[^:@]+:([^@]+)@`, redact group only) + URL userinfo to `secrets-sanitizer.ts` (+ Rust mirror, keep byte-parity). Extend `ENV_VAR_SECRET` suffixes to include `URL/DATABASE_URL/CONNECTION_STRING/DSN`. Deprioritize E.164 phone (PII, not credential; FP risk). ATLAS already snapshots the enable flag at import — skip that part.
- **Log/display redaction wiring (S).** Run `sanitizeSecrets()` over the `JSON.stringify` in `audit-log.ts::auditLog` before append; mirror in `tool-intelligence.ts::auditLog` (sanitize *before* the 200-char truncate). Server-side: sanitize the `errorMessage` snippet in `convex/http.ts:~739` before `logCall`.
- **`/recap` zero-cost session recap (S).** `src/commands/recap.ts`: read last ~20 turns from `getConversationHistory()` (carries `tool_calls`, unlike `session.ts` recent_turns), Counter tool names into activity classes, parse edit/write/shell args for ≤5 touched files, render + last prompt/response previews. Wire `/recap`. (Reframe: ATLAS's session summaries are already zero-cost heuristics — this is a command surface, not a free-vs-expensive win.)
- **`/dump` redacted support bundle (S).** `src/diagnostics/dump.ts` + `/dump`: git short SHA, os/arch/node, `ATLAS_ENV`, channel env-keys as booleans (never values), native-load status, `memories.db` path+size, account plan/credits, last N errors → whole string through `sanitizeSecrets()`. Plain text, copy-pasteable.
- **`/doctor` preflight diagnostic (M).** `src/diagnostics/doctor.ts`, `Promise.allSettled` probes returning `{check, status, fix?}`: Convex reachability + session-token validity (reuse `network-health` + an authed `encryptedFetch`), credit balance (`checkAccountStatus`), native load (try `require`; WARN, JS fallback exists), env-key presence, `memories.db` openable, Ollama/FunctionGemma presence (WARN). Surface via `/doctor` + a desktop panel. Skip Python-isms. Frame as onboarding/support-load reduction (keys aren't user-configurable).
- **Headless oneshot CLI (`bin/atlas`) (M).** `src/cli/oneshot.ts`: parse prompt + `--tools/--model`, `initSession()→initAccountGuard()` then a trimmed `runAgent(... {channel:"cli", isOwner:true})`, final assistant text to stdout, chatter to stderr. Crucially **don't call `boot()`** (no channels/heartbeat/cron/dream timers, so the process exits). Handle approval gates with `--yes` or auto-refuse. Reuse `harness/code-proposer.ts` as the standalone-`runAgent` precedent. Daemon path untouched.
- **At-most-once recurring cron advance + missed-run grace (M).** In `tick.ts`, persist the advanced `nextRunAt` for recurring jobs *before* awaiting `runPrompt` (add `advanceNextRun(jobId)` to `store.ts`) → at-most-once across crashes; keep one-shots at-least-once. Add period-scaled grace (half-period, clamp 120s–2h) in `getDueJobs` to fast-forward past stale slots after downtime. Replace the silent `enabled=false` in `markRun`'s catch with a sticky-error visible state. Parity tests for all three.
- **Cron `context_from` job chaining (M).** Persist per-job output (`data/cron/output/<jobId>/<ts>.md`) from `markRun('success')` (or the `index.ts:1014` `runPrompt` closure where `response.text` is in scope — keep `tick.ts` agent-agnostic). Add `contextFrom?: string[]`, prepend each referenced job's most-recent output (mtime-sorted, ID-validated `/^job_[0-9a-f]{12}$/`, ≤8000 chars), validate refs exist at schedule time. Retention cap.
- **Channel system-prompt hints (S).** `CHANNEL_HINTS: Record<string,string>` (new `src/prompts/channel-hints.ts`) appended into the existing first-iter channel block at `agent.ts:2082`. Seed: telegram (markdown→HTML, 4096 chunks, avoid tables), whatsapp (plain/terse), discord (`<@id>` mentions), slack (mrkdwn), email (rich + subject), overlay (full markdown + inline images). Bonus: revive the dead `preferredLength` hook (whatsapp→terse / email→detailed).
- **Live subagent registry / mid-iteration cancel (S, low impact).** Reuse the long-task `AbortController` pattern: add optional `signal?: AbortSignal` to `runSubAgent` (check at the top of the loop, `sub-agent.ts:445`); add a `Map<stepId,{...,abort}>` in `mesh.ts` + `getActiveSubAgents()`/`cancelSubAgent(id)`; **one-line fix**: pass the existing phase signal into the `runSubAgent` call at `long-task.ts:428` so cancel takes effect mid-phase, not just between phases. Surface as agent tools mirroring `check_long_task`/`cancel_long_task`.
- **Background-process `notify_on_complete` + `watch_patterns` (M).** ATLAS already owns the delivery rails: `long-task-events.ts` (`LongTaskCompletionBus`) + `sources/long-task-status.ts` + `dispatch.ts`, and `monitor-hits.ts` (`MonitorHitBus`) implements watch-pattern-then-notify with dedup. Wire `shell_exec_background` (`shell-monitor.ts`) `child.on('close')` into a `ShellProcessCompletionBus` (mirror `long-task-events.ts`) drained by a ~60-line `IntentSource` into `dispatch.ts`. `watch_patterns` reuses the proactive dnd/posture machinery for its 15s/3-strike limiter. Frame as "wire shell-monitor into existing rails," not "build async notification."
- **Process-group kill + shutdown reaping (M).** Spawn shell-monitor children `detached:true`; on timeout/kill do `process.kill(-pid, ...)` (POSIX) / `taskkill /T /F` (Windows) to reap disown'd grandchildren. In `index.ts:1111` shutdown, group-kill any `status==="running"` shell-monitor processes before exit (a `sleep 300`/dev-server currently survives restart). Optional: thread the `runAgent` `AbortSignal` into `executeToolCallsBatch`. Skip the select-based UTF-8 drain port (ATLAS's `execFileAsync` bounds + event-driven streaming don't have V8's readline-never-EOFs failure mode). Gate `ATLAS_NO_SHELL_GROUP_KILL`.
- **DB corruption defense for `memories.db` (S).** Both primitives already exist (`codebase-sidecar.ts:211` runs `integrity_check`; `vector-index.ts:525` + `installer.ts:410` do backup-before-destroy) — never combined for `data/memory.db`, the one irreplaceable+unprotected DB. Add `openDbSafely(path)`: on existing non-empty file run `PRAGMA integrity_check`; on non-"ok" copy `+ -wal/-shm` to `<path>.<ts>.corrupt` then boot fresh (fail-open) — never overwrite in place. Distinguish `SQLITE_BUSY/LOCKED` (transient, propagate) from `SQLITE_CORRUPT/NOTADB` (back up) via the error `.code`. Skip TLS-record detection (Hermes-specific). Cache the healthy result per process.
- **Desktop crash-loop respawn supervision (S).** `desktop/main.js` spawns the bot once with no respawn. On `botProcess 'exit'` with a non-clean code AND not user-initiated (add a `userInitiatedStop` flag), respawn with exponential backoff capped ~5/min, using `botStartTime` to detect crash-loops (back off harder + tray-notify instead of hammering). Add top-level `process.on('uncaughtException'/'unhandledRejection')` in `src/index.ts` so the supervisor restarts from a clean state. Skip s6/tini (no container story).
- **Per-task model/skills/retries columns (M, depends on 1.8).** Once the task spine exists, add `model_override`/`skills`/`max_retries`/`workspace_kind`+`branch_name`/`goal_mode` columns, user-settable per task via overlay/dashboard. Threading `phase.modelOverride` requires routing an override through `selectForSubAgent` (`sub-agent.ts:482`), not just reading a field. `goal_mode` is the most novel piece.
- **In-process concurrency governor (M).** `src/agents/concurrency-governor.ts`: role-keyed semaphore (`browser:1-2`, `coder:N`, `default:M`) + global ceiling, acquired before sub-agent spawn in `mesh.ts:277` and `dreaming.ts:157`. Fold the existing A2A `MAX_CONCURRENT_TASKS` into it. Preserve Hermes's load-bearing invariant: cap on **live** running count, not per-tick budget. No daemon (defer until a durable task store + tick loop exists). Gate `ATLAS_NO_CONCURRENCY_GOVERNOR`.
- **Vision-routing fix + Whisper hallucination filter (S each, real bugs).** (a) Screenshot tool results are attached as `image_url` blocks with NO `supportsVision` check (`agent.ts:656–674`), and the router only sees `hasMedia` on iter 1 (`agent.ts:1238`) — so a tool-loop iteration can pick a non-vision model right before a screenshot arrives → provider 400. Add a vision-capability guard before attaching image blocks (the bit exists: `supports_vision` per model in the Rust registry). (b) `transcribe.ts` has no silence-hallucination filter; a Whisper "thanks for watching" on a silent clip passes the `.trim()` check (`telegram.ts:1484`) and is sent as a genuine message — the music/ambient Gemini fallback only fires on *empty* transcripts.

---

## 5. Where ATLAS Is Already Ahead (Don't Regress)

- **Model layer / security posture.** Zero client-side LLM keys; all calls proxy through Convex with ECDH P-256 + AES-256-GCM (`crypto-transport.ts`), server-side system-prompt assembly, per-account credit deduction. The native Rust cost-router (`model_router.rs`) has a **status-class-differentiated** circuit breaker (transient 408/429/5xx vs permanent 401/403/404; trips at 6 transient-in-a-row vs 3 permanent; per-provider staggered cooldowns Anthropic 60s/Google 90s/Amazon 120s; half-open auto-reset) — stronger than Hermes's same-model jittered retry. **Do not** add credential-rotation or per-provider profile machinery that assumes client keys.
- **Server-side prompt-cache breakpoints are correct in design** (`convex/http.ts:614`): `serverPrompt` is its own byte-stable `messages[0]` with breakpoint #1; the *only* defect is the client-side volatile clock landing at `messages[1]` (Tier 1.1). The architecture is right — protect it.
- **Dynamic-tool reliability (Skill Forge).** lookup-first (FunctionGemma → FTS5 BM25 → cosine rerank) → closed-loop verifier (handler+tests+capabilities envelope, sandbox-run tests, compile+lint+SAST critics, 3×/10× retry) → **OS-kernel sandbox** (sandbox-exec SBPL `(deny default)` / seccomp+Landlock+netns / AppContainer+JobObject, Rust supervisor, 3-strike auto-archive, approval gate). Materially beyond anything Hermes ships. `request_tools` even auto-queues a Forge synthesis candidate on no-match.
- **On-device perception cascade.** `perception-router.ts::findClickTarget` runs a confidence-gated cascade (click-memory ≥0.90 → AX-exact 0.95 → AX-fuzzy 0.80 → OmniParser 0.82 → UI-TARS-7B ≥0.70 → cloud-VLM) with per-tier telemetry + coordinate scaling, and `capability-detector.ts` picks lite/standard/full profiles from hardware. AX-only no-screenshot capture (`os_inspect`/`os_nav`) and the consolidated `os_computer_action` (modeled on Anthropic computer_20251124) already exist. Far ahead of Hermes here — preserve.
- **Memory depth.** Real MiniLM embeddings + HNSW ANN, knowledge-graph, FTS5, reranker, hopfield associative recall, value-gate (shadow/enforcing with `data/memory-gate.jsonl`), dream-replay consolidation, `flushToMemory` pre-prune extraction (the `on_pre_compress` problem is *already solved* — it runs a Haiku extraction over to-be-pruned messages before summarizing). Don't add a third-party cloud memory backend (Honcho/Mem0) — it contradicts the zero-knowledge/local-first design.
- **Already-present mechanisms Hermes lists as "novel" — defend in review, don't rebuild:** tool-output offload-to-disk with read-path recovery (`tool-output-offload.ts`, 8KB threshold, lossless `read` recovery); code-action / programmatic tool calling (`code-action-tool.ts`, node:vm, tools-proxy); a wired lifecycle hook bus (`src/hooks/`, PreToolUse veto/transform + PostToolUse); centralized rotating logging in the desktop daemon; owner-scoped cron privilege via AsyncLocalStorage (stronger than Hermes for multi-identity channels); symlink-aware/NFC/case-folding sensitive-path deny-list; git_op 4-tier safety with evidence-phrase force-push gate; `[NO_REPLY]` suppression sentinel (just not wired into cron — see 2.7); blocking human-interrupt with inline-keyboard resolution (Telegram); versioned addenda with `revertAddendum`; live-voice barge-in with libfvad VAD + echo-awareness; OmniParser/UI-TARS local grounding.

---

## 6. Explicitly Rejected (Considered, Doesn't Fit / Already Have)

- **Pluggable cloud MemoryProvider (Honcho/Mem0/9 backends)** — contradicts zero-knowledge Convex + local SQLite. The *internal seam* (wrapping the 39-subsystem stack as a "builtin" provider) is marginal; the dead `supabase.ts` is the only candidate external. Low value.
- **Trajectory compressor (`trajectory_compressor.py`, 1508 LOC)** — a leaf on a tree ATLAS hasn't grown; only consumer is an SFT/RL corpus ATLAS doesn't produce. Defer behind 2.13.
- **Batch datagen runner** — no training loop; the closest (meta-harness) is a config optimizer, not datagen. Defer with trajectory work.
- **Remote backends (SSH/Modal/Daytona/Singularity) + FileSyncManager** — conflicts with local-first positioning; speculative until a hosted-compute story exists. (The `ExecBackend` interface that would host them is itself worth ~L if/when sandboxed coding workloads justify it, but ship Local+Docker first by reviving the dead `runInSandbox`.)
- **s6-overlay / Dockerfile / docker-compose** — no container story today; the desktop crash-loop respawn (Tier 3) captures most of the supervision value. A Node-slim Dockerfile is a reasonable L if headless self-hosting becomes a goal.
- **Pluggable ContextEngine ABC, TTS/STT provider registries, full plugin loader + typed provider ABCs, unified platform-adapter contract** — all are one-implementation abstractions today; valuable as cleanup but violate "test value before speculative scaffolding." Pursue only when a *second* implementation is actually committed. (The channel-adapter consolidation is the most defensible — ~6× duplicated owner/typing/retry/media logic — but it's an XL refactor, not a feature.)
- **Per-job model/provider/toolset/workdir cron overrides, cron anti-recursion guard** — the cron tool is already unreachable by the LLM (in no tool-router category), so the recursion gap Hermes guards against doesn't exist. Per-job overrides are low-value until the task spine lands.
- **Probabilistic toolset distributions, ProviderProfile registry, per-provider wire-format adapters, credential-attaching forwarder proxy, holographic HRR memory, MoA standalone tool, voice-memo gateway normalization, streaming-draft rendering, tools-as-code** — ATLAS already has the substance (OpenRouter normalizes wire formats; Convex *is* the forwarder; HNSW+KG beats HRR; MoA is wired into swarm synthesis; voice transcription is per-channel; edit-based streaming achieves the UX).
- **24-reason API-error classifier, full credential pool with leases/4 strategies, Honcho dialectic user-modeling, on_pre_compress as new capability, prefetch-into-current-message, kernel sandbox for shell** — either already present in stronger form or collapse to the right-sized subsets captured in 2.6 / 2.12 / 2.x.

---

## 7. Suggested First PR

**Fix the prompt-cache prefix bug (Tier 1.1).** Highest impact/effort ratio, fully self-contained, no new subsystem, and it unblocks the caching upside of several later items (goal-loop continuation, background review, every multi-iteration Heavy/Pro turn).

**File-level plan:**

1. **`src/llm.ts:171–181`** — Change the `[SYSTEM CLOCK]` content to a coarse bucket. Replace the to-the-second timestamp with date + hour (e.g. `2026-06-02 14:00 UTC`), so the block is byte-stable within an hour-long session. Keep the widgets/language portion only if it's already stable; if it varies per-request, move the whole `dynamicContext` block to the **end** of the message array instead (after the last user/tool message) with no breakpoint — pick whichever is the smaller diff for the current call sites.

2. **`src/agent.ts:~2054–2065`** — Confirm `fencedInjection` (iter-1 memory/research/casual-nudge) stays in the transient `iterationMessages` array only (it already does per the structured pass). If turn-1 history caching matters, relocate the iter-1 `fencedInjection` to sit *after* `...messages` rather than between the system prompt and history, so breakpoint #3 (`http.ts:666`) covers a stable prefix on turn-1 too. Leave the `iterations===1` guard intact.

3. **`convex/http.ts:583–590`** — In the `systemPromptOverride` merge path (sub-agents/classifiers), ensure the client dynamic-context (clock) is not folded into `messages[0]` ahead of the override's system breakpoint. Mirror the normal-path separation comment at `http.ts:606–613`.

4. **Verification** — Add a parity test (or a manual check) asserting `cachedTokens` in `convex/llmCallLog.ts` jumps from ~0 to >0 on the 2nd+ iteration of an Anthropic-model tool loop. Run a 3-iteration Opus tool loop and confirm `cachedTokens > 0` on iterations 2 and 3.

5. **No Convex schema change, no native rebuild.** Pure TS, ESM, minimal comments, `© 2024-2026 XAGI Labs Private Limited` header preserved on any touched file.

Scope is ~20–40 lines across three files. It's a cost regression fix masquerading as a one-liner — exactly the kind of high-confidence, low-blast-radius change to lead with before the larger durable-spine and checkpoint work.