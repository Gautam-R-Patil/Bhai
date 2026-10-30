# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bhai (v0.2.1) is a continuously running, proactive personal AI agent: Node.js/TypeScript (~580 non-test `.ts` in `src/`; ~1,030 tracked incl. tests, `convex/`, `desktop/`) + native Rust performance layer (~80 `.rs` in `native/src/`). Autonomous computer use, deep research, and long-running async workflows via Telegram, Discord, Slack, Matrix, WhatsApp, desktop overlay, email.

## Build & Run Commands

```bash
npm run dev              # tsx --watch
npm run build            # TS → dist/ (postbuild copies overlay.html)
npm start                # production build
npm run build:native     # Rust native module
npm run build:ocr        # Swift OCR helper (macOS)
npm run build:location   # Swift CoreLocation helper (macOS; predev hook)
npm run build:helpers    # OCR + location + AX Swift helpers (macOS); the Mac builds fail without them
npm run build:all        # native + helpers + TS
npm run lint             # Biome check
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
npm run test:hermetic    # scripts/run-tests.sh: secrets/ATLAS_* unset, TZ=UTC, 4 workers (what CI runs)
npm run test:watch       # vitest watch

npx convex dev
npx convex deploy

# Desktop (Electron 40+, electron-builder)
cd desktop && npm start
cd desktop && npm run build:mac   # macOS DMG (create-dmg.sh)
cd desktop && npm run build:win   # Windows NSIS installer
```

Requires Node.js 20.19+ or 22.12+ (below that, `npm ci` skips rolldown's optional native binding and Vitest won't start). Vitest. CI runs on push/PR to `main` (`.github/workflows/ci.yml`): typecheck + `npm run test:hermetic` on Node 22/24 × Linux/macOS/Windows, Biome on changed files only (PRs; the repo is only partly formatted), native build matrix, clippy + rustfmt; plus CodeQL, dependency review, workflow lint.

## Architecture

### LLM Client (`src/llm.ts` + `src/crypto-transport.ts`)
All LLM calls proxy through Convex — client never holds API keys. `createLLMClient()` returns `LLMClient.chat()` that builds messages with dynamic context, sends to `${convexSiteUrl}/api/llm/chat` via ECDH P-256 + AES-256-GCM (`encryptedFetch()`) over HTTPS. Server prepends its own system prompt (`convex/systemContent.ts`).

Models in `MODELS` constant (Opus, Sonnet, Haiku, GPT-5.x, Gemini). `LLMClient` injected into agent, tools, swarm, research.

Client-side layers in `.chat()`:
- **Semantic response cache** (`llm-cache.ts`) — Embedding cache (cosine ≥ 0.97 (`ATLAS_LLM_CACHE_THRESHOLD`), 10min TTL, 200 LRU); tool-state not in cache key. Only caches simple queries (no tool calls or thinking).
- **Adaptive language matching** (`language.ts`) — Unicode script + keyword heuristics; injects "Respond in {language}". Devanagari/CJK/Cyrillic/Arabic/Hangul/Thai/Latin incl. Romanized Hindi/Hinglish.

### Boot Sequence (`src/index.ts`)
1. Session + Auth (`initSession()` → `initAccountGuard()` credit check)
2. Memory (SQLite, KG, traits, emotional, episodic, self-state)
3. Async warmup (non-blocking): `warmupEmbeddings()`, `embedExistingMemories()`
4. Tool infra (MCP, skills, browser memory, Docker sandbox, tool router category embeddings)
5. Channels (Canvas WS, Google APIs, overlay chat, email IMAP/SMTP, Telegram)
6. Scheduled (heartbeat, memory decay 6h, dream replay nightly 3am)

### Agent Loop (`src/agent.ts:390` — `runAgent()`)
1. Account gate (credits)
2. Message preprocessing + context pruning
3. **First iteration**: ~12 memory retrieval systems fire (identity, traits, session summary, self-state, emotional, episodic, relationship, anticipation, core, query recall, task learnings, KG entities); three primary queries (semantic/conversation recall, task learnings) in one `Promise.all`. Budget ~2-3K tokens.
4. **Each iteration**: `chooseModel()` (native router) → semantic tool selection → LLM call → tool execution → completion check
5. Browser tools sequential (shared page state), and so are screen-driving tools (os_*, app_manager, apple_script, window_manage, run_shortcut) in call order; others parallel. Tool results carrying `screenshot_base64`/`zoomed_base64` are turned into image parts before offload/truncation (≤1568px), and only the newest few screenshots stay in history. Cascade escalation on errors (Haiku → Sonnet → Opus). Max 200 iters; credit check every 5 tool calls.

**Reliability layer (Oct 2026):**
- **Per-turn nudges** — steering messages go through `pushNudge` and are stripped at turn end; a context prune is computed after the turn and applied before the next turn's history cap.
- **Send ledger** (`src/tools/send-ledger.ts`) — the same message/file to the same recipient within 10 min is refused unless the call passes `resend: true`; in-flight sends report "still being sent".
- **Task contract** — the first line of real work is "on it — …; done = …" (prompts/rules.md); the `[ACK] ` progress line shows it and the verify nudge quotes the done-criterion back.
- **Stuck report** — "never give up silently, never fake done": after 2-3 different attempts, or when only the owner can unblock, the reply ends with `[[STUCK]]` (stripped by `takeStuckMarker`, `src/channel-text.ts`); Telegram shows I'll take over / Retry / Skip, other channels a reply line. Failing exits (circuit breaker, LLM failures, iteration cap) return a stuck report too.
- **Done receipt** — after a mutator plus a later screenshot, the owner's private chat gets the clean (ungridded) screenshot; never on vault/withheld turns, failed last actions or stuck turns.
- **Step heartbeat** (`src/step-status.ts`) — progress reads "step N · status · Ns", re-sent every ~20s while a tool batch runs.
- **Playbooks** (`src/memory/playbooks.ts`) — a programmatically verified win stores its tool steps in task-learnings (no bodies, secrets, emails or phones); a failed replay demotes it.
- **Swarm approval gate** (`src/agents/swarm-context.ts`) — inside swarm runs, explicit external-action tools, per-call-consent tools and shell launchers are held until the owner's fresh yes (`swarm_task confirmed: true`, enforced by `src/security/consent.ts`); payments/orders never run in a swarm. Accepted limit: effects through generic UI clicks or self-written scripts.

### Model Router (`src/model-router.ts` + `native/src/model_router.rs`)
TS wrapper around napi-rs native binary (falls back to JS-only). Factors: iteration count, errors, last tool calls, media, user hint. Every id lands on one of three Claude models (`convex/claude.ts` toClaudeModel), billed per call: **Haiku** 0.25cr, **Sonnet** 1cr, **Opus** 2cr.

**Learned router** (`src/routing/learned-router.ts`, on by default; `ATLAS_NO_LEARNED_ROUTER=true` turns it off): on iteration 1 of a non-complex, non-unhinged turn with no explicit ask for depth, it picks the model for the turn's kind of task (chat/quick/desktop/browser/coding/research/vision/general) among Haiku, Sonnet and Azure `azure/gpt-4.1-nano|gpt-4o-mini|gpt-5-mini|gpt-6.1-terra` (served by `convex/grok.ts`, Claude fallback): the cheapest whose Beta-estimated success is within 0.05 of the best, ~5% Thompson exploration on the owner's low-risk turns. Priors from `scripts/eval-computer-use.ts` (~10 pseudo-tasks), 14-day decay, outcomes from `settleLearnings` (verified 1 / unchecked 0.5 / stuck 0.5 fail; provider errors and served-model mismatches not counted; the owner's quick "no, that's wrong" counts). Evidence in `data/router-stats.json`; `RECORD=1` evals add to it. The pick holds the turn until an error, a widening into browser/code, or a nudge for a stronger model.

Task-context routing (iteration 1): the tool router's lean classifier also returns `tier` (chat|simple|standard|complex) and `multi_step`. `agent.ts` adjusts the native pick from it: chat → Haiku with thinking off and only `request_tools` (the "chat lane"), simple → Haiku with low thinking, complex → at least Sonnet. The planner runs only for multi-step/complex/chained work; later iterations reuse the turn's tool set (prompt cache). A non-complex desktop-only turn (classifier categories ⊆ os_control/app_management/system_controls) stays on Haiku for its first 8 iterations instead of the native router's iteration-3 Sonnet bump, until a step fails, metacognition flags a loop, or request_tools widens it; it also skips the periodic memory nudge. The verify-before-done gate is order-aware and counts a screenshot (the model sees it) taken after the last action. Opus is gated by `opusWarranted()` (explicit ask, `modelHint` complex, or 3+ errors). Helper calls (classifier, HyDE) pass `lean: true`: no thinking, no client clock block, and no server `rules` preamble when tool-less. `reasoning.effort: "none"` turns thinking off in the proxy (Haiku `disabled`, Sonnet `between_tools`). HyDE runs only in `retrieve` mode. LLM telemetry logs cached tokens.

### Tool Router (`src/tool-router.ts` + `src/tool-router-analytics.ts`)
Semantic selection via MiniLM (384-dim). Boot: embed each category description. Per-message: embed query → cosine top-K → load schemas. MCP tools and runtime-made Forge tools (`getDynamicToolSchemas`) are scored against the message embedding and fill the remaining slots; a successful `create_tool`/`approve_dynamic_tool` makes the next iteration reselect. `request_tools` meta-tool expands mid-task. 20+ categories. Analytics learn intent→tool preferences. FunctionGemma (`src/models/function-gemma.ts`) is used only by Forge lookup, not routing.

### Memory System (`src/memory/` — ~60 files)
All local SQLite (`data/memory.db`):
- `sqlite.ts` — Primary store: `remember()`, `recall()`, `getCoreMemory()`; `knowledge-graph.ts` — entity-relationship graph; `vector-index.ts` — HNSW ANN; `reflection.ts` — nightly dream replay + 6h decay; `task-learnings.ts` — recurring-task strategies
- Specialized tiers: `identity`, `traits`, `emotional`, `episodic`, `self-state`, `session`, `relationship`; short-term: `working-memory`
- Predictive: `counterfactual`; consolidation/retrieval: `sleep-gate`, `surprise-gate`, `reranker`, `strategy-library`
- `classifier`, `context-pruning`, `at-rest-scrub` (one-time scrub of secrets saved before at-rest masking; card numbers, codes and typed passwords are no longer stored in plaintext); goals/self-improvement: `goals`, `self-evolving`, `memory-informed-planning`; plus `consolidation`, `multimodal`, `temporal-cache`, `embeddings`, `multimodal-embedding`

### Channel Flow (Telegram: `src/telegram.ts`)
`Message → whitelist → media extraction → runAgent() → streaming → smartChunkMessage() (sentence boundaries) → Markdown→HTML → send`. Internal tags (`<system_log>`, `<tool_log>`) stripped before send.

### Convex Backend (`convex/`)
API key proxy + auth + store backend — LLM keys never reach client:
- `http.ts` — LLM proxy with E2E encryption; `sessions.ts` — session tokens (24h TTL, ECDH); `accounts.ts` — credit tracking + atomic deduction (free/pro/enterprise); `crypto.ts` — server ECDH + AES-256-GCM; `systemContent.ts` — server-side prompt assembly
- `schema.ts` — `accounts`, `sessions`, store tables (`developers`/`admins`/`store_items`/`submissions`/`store_installs`/`store_reviews`/`store_activity_log`), system content (`system_prompts`, `system_skills`)
- `convex/store/` — Store CRUD (`items`/`submissions`/`developers`/`storage`/`admins`/`installs`/`reviews`)

### Native Rust Layer (`native/src/` — ~80 .rs files incl. `forge_sandbox/`)
SIMD vector ops (~15-20x) via napi-rs. Built `opt-level=3`, LTO, `panic=abort`, stripped. Deps: `wide`, `simsimd`, `rayon`, `aes-gcm`. Modules mirror TS; `lib.rs` is napi entry, `chrome_bridge.rs` the extension bridge.

### Agent Orchestration (`src/agents/` — ~36 files)
Four-tier execution model.

**Core Tiers:**
- **Sub-Agent** (`sub-agent.ts`) — Roles (researcher/coder/browser/system/general); scoped tools, loop detection, error escalation, `request_tools` expansion, priority-based timeout/model, partial streaming, per-iteration cost
- **Swarm** (`swarm.ts`) — Decomposes into sub-agent steps (max 20) via Mesh; evaluator-optimizer loop + replanning + task learnings. Triggered by `swarm_task`
- **Mesh** (`mesh.ts`) — Parallel DAG: critical path, layered recovery (retry→rephrase→reroute→skip), structured handoffs, dynamic roles
- **Long-Task** (`long-task.ts`) — 200 iter/phase, 30min timeout, max 100 phases. Checkpoints to `data/long-tasks/${taskId}.json` every 60s; max 3 inter-phase replans

**Reliability:** `error-recovery.ts` (retry→rephrase→reroute→skip), `error-types.ts` (`ErrorCategory`), `smart-truncate.ts` (tool-specific: shell tail-heavy, JSON parse+prune, browser keep IDs, files head+tail), `handoff.ts` (300-char summary, 5 findings, artifacts, errors)

**Optimization:** `evaluator.ts` (0-100 scoring + retry), `replanner.ts`, `role-analyzer.ts` (overrides LLM roles when conf >0.7), `mixture.ts` (MoA, ≥5 steps), `speculative.ts` (races approaches), `decomposition-library.ts`, `complexity-classifier.ts`

**Self-Improvement / Specialized:** `metacognition.ts`, `multi-critic.ts`, `code-critic.ts` (compile+test+lint+SAST+ui_verify, fires `swarm.ts:~215` for coder steps, weights 0.4/0.4/0.2/0.15, budget `ATLAS_POST_SYNTHESIS_BUDGET_MS` 90s), `agent-worktree.ts` (opt-in `ATLAS_AGENT_WORKTREE=true`, `data/agent-worktrees/<id>/` when ≥2 coders race), `textgrad-refiner.ts`, `self-editor.ts`, `self-heal.ts`, `code-action-agent.ts`

### Coding Agent Pipeline (`src/tools/coding/` — 25+ files)
Staged pipeline with runtime gating. Read before touching `src/tools/coding/` or `plan-mode.ts`.

**Complexity classification** (`src/model-router.ts::classifyCodingComplexity`): first-iter regex classifier → `"trivial"|"standard"|"complex"`; `src/agent.ts` injects `<coding_complexity>`. Trivial skips Pro tier + docs. Standard implements on Pro. Complex (refactor/new-system/build-verb + high-stakes / >400 chars) fires design-docs flow.

**Pro-tier routing** (`maybeEscalateForCoding`): non-trivial coding forces tier ≤ 4. Tiers inverted: 0=Opus, 2=Sonnet, 3=Gemini Pro, 4=Nova Pro, 5=Haiku, 6-9=lighter; `PRO_TIER_CEILING=4`. `selectForSubAgent(..., role)` pins coders to Pro. Extended thinking lifts unless `ATLAS_NO_CODING_THINKING=true`.

**Complex-task flow:**
1. **Design docs** — `generate_design_docs({ task })` writes PRD/TECHNICAL/ARCHITECTURE.md under `design-docs/<slug>/` (in-tool Sonnet `json_object`, falls back to templates). **Auto-transitions plan-mode to `awaiting_approval`** — implementation runtime-blocked.
2. **Approval gate** — `awaiting_approval` is the fourth plan-mode state. Allowlist `AWAITING_APPROVAL_ALLOWED_TOOLS`: reads, `edit`/`write` restricted to design-docs dir via `checkWritePathInApprovalMode()`, channel senders, `render_md_to_pdf`, `approve_design_docs`, `generate_design_docs`. `shell_exec`/`test_run`/arbitrary `edit` refuse at tool layer. Approval → `approve_design_docs({ user_quote })` (quote required) → `act` mode.
3. **Implement** — standard coder loop on Pro. Worktree isolation if `ATLAS_AGENT_WORKTREE=true` AND ≥2 parallel coders.
4. **Walkthrough** — `demo_project({ project_dir })` auto-detects stack + launches runtime; agent runs `browser_verify`/`os_screenshot`/`screen_record`, then `generate_walkthrough({ repo_root })` reads the uncommitted diff (or `git log` since `since_commit`) → WALKTHROUGH.md. Delivery: overlay (MD + screenshot), TG/WA (PDF + media), Discord/Slack (attach MD).

**Write-path gating** (runtime): `edit.ts`/`write.ts` call `checkWritePathInApprovalMode(filePath)`; in `awaiting_approval` only `designDocsDir` paths pass.

**Debug logs** — coder tool calls emit breadcrumbs via `src/utils/debug-log.ts::logToolAction(...)`. Format `🔧 [tool] sub_agent=id role=r | path:line — action`. Silence with `ATLAS_TOOL_DEBUG=false`.

### Codebase Comprehension (Phase 4L — `src/memory/codebase-*` + `src/tools/coding/codebase-*`)
Per-repo SQLite sidecar under `data/codebase-index/<repo-hash>.db` (distinct from `memories.db`). Auto-built on first coding iteration.

- **`codebase-sidecar.ts`** — Schema `4L.3`. Tables: `files`, `symbols`, `imports`, `calls`, `parse_errors`, `index_meta` + `symbols_fts` FTS5.
- **`codebase-merkle.ts`** — SHA-256 + repo-root resolution; incremental refresh skips unchanged files.
- **`code-parse/`** — `tree-sitter-extractors.ts` default for TS/JS (tree-sitter 0.22.4 + typescript 0.23.2); `regex-extractors.ts` fallback (15 langs). Python/Rust/Go gated behind `ATLAS_MULTI_TREE_SITTER=true` (0.22 collision bug); `ATLAS_CODE_PARSER=regex` forces legacy. Max 500KB/file.
- **`codebase-index.ts`** — `buildIndex`/`refreshIndex`/`getIndexStats`/`wipeIndex`. `pickDepth()`: ≤500 files→`calls`, ≤5000→`imports`, else→`symbols` (`ATLAS_INDEX_DEPTH` overrides). `ensureIndexForCoding(root)` on first coding iter; `pickTiming()` (≤100→block). `getArchitectureSnippet(root)`→Mermaid + ASCII.
- **`codebase_query` ops** (`codebase-query.ts`): `find_symbol`, `find_usages`, `search` (BM25), `ego_graph` (k-hop BFS), `file_neighborhood`, `describe_file`, `architecture_overview`, `dependency_chain`.
- **`codebase_index` commands**: `build`/`refresh`/`stats`/`wipe`. Uses raw better-sqlite3 (`getRawSidecar()`), not the wrapped helper (routes to `memories.db`).
- **`self-evolving.ts`** — Nightly prune skips `category='code'` AND `category NOT LIKE 'code\_%'`. Add new coding-memory categories here too.

Read-side: `code_change_summary` (git `recent_commits`/`hot_files`/`diff`/`blame`), `agents_md_scaffold` (AGENTS.md + 8 sub-docs, `<!-- @atlas:auto -->`), `lsp` `getDiagnostics` (auto-attached to edits as `post_edit_diagnostics` unless `ATLAS_NO_POST_EDIT_DIAGNOSTICS=true`). Write-side: `git_op` 4-tier safety (safe/confirm/destructive/blocked); protected branches `main`/`master`/`production`/`release/*` + evidence-phrase gate for `push --force`/`--force-with-lease`; ephemeral `checkpoint`/`restore_checkpoint` via `git stash create`.

### Workspace & Artifact Outputs (`src/config/paths.ts`)
User-facing artifacts under `getWorkspaceDir()`: `$ATLAS_WORKSPACE` → `~/Desktop/Bhai Files` → `~/Documents/Bhai Files` → `~/.atlas/files` → `~/Bhai Files` → `os.tmpdir()`. On-demand subdirs: `getCodeDir()` (`scaffold_project` default), `getDocumentsDir()` (`design-docs/<slug>/` + `walkthroughs/<slug>/`), `getImagesDir()`, `getScreenshotsDir()`, `getDownloadsDir()`, `getTempDir()`.

Rule: tools writing user artifacts default to `getWorkspaceSubdir()`, override only when user names a path. `data/` is ATLAS-internal state.

### Browser Tools (`src/tools/browser/` — ~27 files; `src/tools/` ~140 files)
Dual-backend via `BrowserBackend` interface (`browser-backend.ts`):
- **Playwright** (`playwright-backend.ts`) — headless Chromium, persistent profile `data/browser-profile/`
- **Chrome Extension** (`chrome-backend.ts` + `chrome-bridge.ts`) — WS bridge to real Chrome; `ChromePageProxy` mimics Playwright Page API
- `mode-tools.ts` (fast DOM ↔ vision OCR switch)
- 25+ actions: navigate/click/type/scroll/extract, parallel tabs/actions, upload, JS exec, strategy save/recall

### Tool Intelligence (`src/tools/tool-intelligence.ts` + `create-tool.ts`)
Per-tool caching (web_search 2min, read_file 1min, system_info 5min), rate limiting, audit log, confirmation gates. **Dynamic tools** persist to `~/.atlas/store/tools` and hot-reload; session handlers run under `runIsolated` (`src/security/vm-isolate.ts`) as `(input, utils, console)` (utils: read-only path-checked fs, path, homedir, JSON, require of path/fs/os; exec/fetch denied). Persisted Forge tools get the same `utils` in their kernel-sandboxed child (`wrapPersistedHandler`).

### Skill Forge — Phase 4 persisted-tier sandbox (`src/forge/sandbox-supervisor.ts` + `native/src/forge_sandbox/`)
Persistent synthesized tools (`req.persistent === true`) live at `~/.atlas/store/dynamic/<slug>/{handler.js, manifest.json}` and execute inside OS-isolated Node child processes. The fence is the **kernel**, not the JS runtime — macOS sandbox-exec (SBPL profile per-spawn at `.sandbox.sb`), Linux seccomp + Landlock + CLONE_NEWNET via pre_exec, Windows AppContainer + JobObject (spawn deferred). Rust supervisor napi exports: `forge_invoke_tool`, `forge_spawn_warm`, `forge_evict`, `forge_strikes`, `forge_clear_strikes`, `forge_set_pool_size`. Pool: LRU cap 10, never evicts inflight. Three-strike auto-archive: 3 cap violations within `ATLAS_FORGE_STRIKE_WINDOW_MS` (default 1h) archives the slug; boot-failure burns all 3. `approve_dynamic_tool({slug, user_quote})` flips awaiting_approval → active + registers a closure delegating to `invokePersistedTool`; `revoke_dynamic_tool` evicts + clears strikes + archives. Plan-mode state `awaiting_dynamic_tool_approval` gates to approval/revoke tools only. `initForge` boot-scan re-registers approved manifests. 15-pattern adversarial regression suite (`capability-bypass.test.ts`) locks defeated bypass classes. Kill switches: `ATLAS_NO_FORGE_SANDBOX`, `ATLAS_FORGE_POOL_SIZE`, `ATLAS_FORGE_CALL_TIMEOUT_MS`, `ATLAS_FORGE_STRIKE_WINDOW_MS`, `ATLAS_FORGE_LANDLOCK_OPTIONAL`, `ATLAS_FORGE_STRICT`, `ATLAS_FORGE_LINUX_NET_PASSTHROUGH`, `ATLAS_FORGE_WINDOWS_STRICT`.

### Skill Forge (`src/forge/` — Phases 1+2+3 shipped)
Dynamic-tool reliability layer. P1: foundation (SQLite library, manifest, hot-reload). P2: lookup-first short-circuit so `create_tool` reuses before synthesizing. P3: closed-loop verifier — LLM emits `{handler_code, tests, capabilities_declared, side_effects, synthesis_notes}`; sandbox runs tests; critics check compile + lint + SAST; diagnose prompt retries up to 3× (Track A/sync) or 10× (Track B/dream-replay). Pro-tier via `tool_synthesis` TaskType (Sonnet default; Opus + max with `ATLAS_FORGE_DREAM_OPUS=true`).

Lookup pipeline: FunctionGemma 270M (zero cost) → FTS5 BM25 over description+schema_keys → cosine rerank (0.85). A hit is reused only while its tool is registered in this process (not awaiting approval, archived, or a session tool from before a restart).

Verifier (`src/forge/verifier.ts`): `parseEnvelope` → `runCompileCheck` (acorn, hard-fail) → `runSastCritic` (11 regex rules) → `runTestInSandbox` per test (the session-tool runtime, 10s) → `scoreResult` against `expected_kind` (8 variants; `side_effect_*` always fail, all-bare-`throws` suites count as self-bait). Failures build `buildDiagnosePrompt` + retry; cap via `ATLAS_POST_SYNTHESIS_BUDGET_MS` (90s); dumped to `~/.atlas/store/dynamic/_failed/<ts>_<slug>.json`.

Public API (`src/forge/orchestrator.ts`): `initForge`/`isForgeReady`/`getForgeStats`/`shutdownForge`, `setForgeLLM(client)`, `lookupTool(description, schema)` → `ToolMetadata|null`, `synthesizeTool(req)` → `SynthesisResult` (`lookup_hit`|`synthesized`|`awaiting_approval`|`failed`), `queueSynthesisCandidate`/`consumeNextPendingCandidate`, `runDreamReplaySynthesis` (P6 stub).

Wiring: `pending-consumer.ts::consumeOnePending()` pulls one queued candidate; `src/agent.ts` end-of-turn hook fires it fire-and-forget; `create-tool.ts` routes through `synthesizeTool` when ready, falls back to legacy on `ATLAS_NO_FORGE_VERIFIER=true` or offline.

Router additions: `TaskType` += `"tool_synthesis"`; native enum `ToolSynthesis` + map entries. `maybeEscalateForSynthesis(base, isDreamReplay)` — Track A/B: Sonnet + high (Opus + max if `ATLAS_FORGE_DREAM_OPUS=true`). `selectForToolSynthesis()` is public entry. `selectForAgent` inserts synthesis escalation BEFORE browser/coding when `lastToolCalls` has `create_tool`.


### Deep Research (`src/research/` — 11 files)
Background engine: `executor.ts` (≤500 sources), `engines.ts` (search providers; Parallel is the first engine for `web_search` and research, proxied via Convex `/api/search/parallel` so `PARALLEL_API_KEY` stays server-side), `fetcher.ts` (HTML→text), `scoring.ts`, `persistence.ts` (`data/research/`), `hypothesis-engine.ts`, `credibility-model.ts`, `analysis.ts`, `profiles.ts`.

### Runtime Data (`data/`)
Gitignored; internal state ≠ user-facing outputs (see Workspace). `memories.db` (all memory subsystems), `codebase-index/<repo-hash>.db` (Phase 4L sidecars), `agent-worktrees/<step-id>/` (only with `ATLAS_AGENT_WORKTREE=true`), `long-tasks/` (checkpoints), `research/`, `browser-profile/`, `google-credentials.json` + `google-tokens/`, `proactive-config.json` (per-channel posture/night windows, hot-reload).

### Social Cognition (`src/social/`)
`emotion-detector.ts` — zero-cost heuristic (lexicon + punctuation) → `{ primary, valence, arousal, signals }`. `dynamic-context.ts::buildDynamicContextReminder` bridges into `assembleDynamicPrompt`'s `userEmotionalState`; injected on first iter. Stubs (`theory-of-mind`, `pragmatics`, `persuasion`) removed — LLM handles natively.

### Planning (`src/planning/`)
`mcts-planner.ts` (UCB1, PRM-scored), `hierarchical-planner.ts`, `process-reward.ts`, `logic-verifier.ts`. Swarm runs them only with `ATLAS_SWARM_DEEP_PLANNING=true` (~25 extra LLM calls per plan).

### Local Models (`src/models/` — 5 files) — zero-API-cost on-device
`function-gemma.ts` (270M via Ollama, used only by Forge lookup, not tool routing), `local-asr.ts`, `local-tts.ts`, `local-ocr.ts`, `local-vision.ts`.

### Dynamic Prompts (`src/prompts/`)
`dynamic-assembler.ts` (context-aware assembly: task type, emotional state, relationship depth, hour-of-day), `prompt-evolver.ts` (iterative refinement), `watermark.ts`.

### Alive UX + Network Health + Location
- **Alive UX** (`src/alive-ux.ts`) — centralized personality/phrasing; prevents repetition, adapts tone
- **Network Health** (`src/network-health.ts`) — online/degraded/offline tracking; `isOnline()` gate; 45s passive / 15s recovery
- **Location** (`src/location/` — 7 files) — singleton GPS → Wi-Fi → IP; `network-watcher.ts` drives refresh; Swift helper on macOS

### Widget (`src/widget/widget.ts`)
Embeddable chat widget at `/widget.js` from overlay server; IIFE injects DOM + styles + WS; `?token=` auth.

### Additional Subsystems
- **MCP** (`src/mcp/`) — `client.ts`, `gitmcp-bridge.ts` (exposed as `gitmcp_docs` via `src/tools/gitmcp.ts`)
- **Proactive** (`src/proactive/` — ~60 files) — Heartbeat, behaviors, night dreaming. P0+1: `intent.ts`/`intent-from-thought.ts`, `composer.ts`/`composer-templates.ts` (template → LLM → banned-phrase + third-person filter), `dispatch.ts` (single exit, mode emoji 💡/❓/✅), `config.ts` (per-channel posture calm/active/ambient; `data/proactive-config.json`), `kill-switches.ts`. Plus `goal-engine`, `habit-detector`, `inner-thoughts`, `thought-journal`, `trigger-detector`, `notification-tracker`, `environment-sensors`, `proactive-reward`, `dnd`, `monitors`, `activity`, `recommendations`.
- **Security** (`src/security/`) — `sandbox.ts`, `allowlist.ts`, `secrets-sanitizer.ts` (scans tool results for keys before LLM), `audit-log.ts`, Docker isolation
- **Voice** (`src/voice/`) — `telegram-voice.ts`, `transcribe.ts`, `tts.ts` (`ATLAS_TTS_PROVIDER` → `ELEVENLABS_API_KEY` → `OPENAI_API_KEY`), `live/` (continuous voice)
- **Canvas** (`src/canvas/`) — WS canvas channel; **Commands** (`src/commands/`) — slash-command parsing; **Skills Loader** (`src/skills/`) — gray-matter MD from `skills/` + `~/.atlas/store/skills`
- **Store** (`src/store/`) — `client.ts`, `installer.ts` (download + extract + hot-reload), `sideload.ts`, `hot-reload.ts`. Read-only agent access via `store_browse` (search/list/info/featured/trending/categories/installed). Install/uninstall in desktop UI only.
- **Channels** — Discord (`src/discord.ts`), Slack (`src/slack.ts`), Matrix (`src/matrix.ts`)
- **Bhai mail** (`src/bhai-mail.ts` + `convex/bhaiMail*.ts`) — Bhai's own address `<name>.bhai@xagilab.com`, created in one click. The server reads the shared mailbox and queues each user's mail; owner mail gets full Bhai, anyone else gets guest mode (own conversation, `NON_OWNER_TOOLS`); newsletters/auto-replies are announced, never answered. Separate from the user's own IMAP/SMTP (`src/email.ts`).
- **Devices** (`convex/devices.ts`) — Account → Devices lists the `platform:host:user` fingerprints that got sessions; removing one signs it out until someone signs in on it again. A verified sign-in (`/api/otpless/validate-token`) gives the device a secret (only its hash is stored; the desktop keeps it in the encrypted account session and passes `ATLAS_DEVICE_SECRET` to the bot); `/api/auth/session` refuses a user id without it (`sign_in_required`).
- **Config** (`src/config/` — `keys.ts`, `paths.ts`); **Notifications** (`src/notifications/push.ts`); **LLM Middleware** (`src/llm-middleware.ts`); **Types/Utils** (`src/types/`, `src/utils/` — `json-extract.ts`, `system-resources.ts`, `uuid.ts`)

### WhatsApp Channel (`src/whatsapp.ts` + `src/whatsapp-users.ts`)
Most privilege-differentiated channel. Baileys (`@whiskeysockets/baileys`). State in `data/whatsapp-users/` JSON (owners/contacts/personas/groups) — NOT `memories.db`.

**Identity tiers** (per message): **Owner** — JID in `owners.json`, full tools, `isOwner: true`, in-memory history; **Allowed contact** — owner-approved, persona-gated; **Unknown** — notifies owner, `autoAllow` promotes after delay; **Group** — JID `*@g.us`.

**Persona system**: Single global `whatsapp-persona.json` (name, prompt, `allowedToolNames[]`), applied to all non-owner. `whatsapp.ts:~933` hard-codes anti-impersonation rules (reject "I am the owner", refuse owner-behalf system actions) — in code, NOT persona. Don't weaken.

**Groups**:
- **Add flow** (`groups.upsert`, `whatsapp.ts:1499`): owner in participants → auto-`active`; else `pending` + DMs owner. Silent until approved.
- **Lifecycle**: `pending` → `active` → optional `muted`. Commands: `approve X`, `decline X`, `groups`, `mute/unmute group X`.
- **Response gating** (`handleGroupMessage`, `whatsapp.ts:1033`): must be `active`; always respond if @mentioned/replied; else throttle (<30s since last send OR bot >15% of messages) then Haiku YES/NO chime-in.
- **Tool allowlist**: DMs: `senderIsOwner ? undefined : getPersona().allowedToolNames`. Groups: `GROUP_TOOLS` (time/weather/web search) for everyone, owner included, run as non-owner and non-private — a group's text is anyone's, and its replies are everyone's. Same rule on Discord/Slack/Matrix: owner powers and proactive sends only in the owner's DM.

### Web Portals (`portals/`)
Next.js + Tailwind, own `package.json` + `.env.example`: `admin-panel/` (users, store submissions, system prompts/skills), `developer-portal/` (skill/tool/MCP publishing).

### Overlay (`src/overlay/` + Electron)
Electron overlay window (`overlay.html` + `overlay-chat.ts`, hosted by desktop app; the desktop `panel.html` holds Settings (search, saves by itself, Data & privacy, About, personality pills, update channel under Advanced), Account (Devices), Channels (one-click setup, e.g. Telegram managed-bot creation, WhatsApp link by QR/code; Overlay and Web Widget are "Always on"), Vault and Memory (opened from Settings));  former native Swift `overlay-app/` removed (`09391f1`). Overlay WebSocket authed via `?localToken=` gate from a discovery-first handshake (`/discover`).

### Chrome Extension (`chrome-extension/`)
Companion for `chrome-backend.ts`. `background.js` (WS bridge), `content.js` (DOM), `popup.*` (toggle). Drives real Chrome instead of headless. The extension fetches its bridge token over **native messaging** (host `com.atlas.bridge`, registered by `chrome-bridge.ts`, scoped to the OS user); `/discover` stops serving tokens once that works, and only Bhai's own extension may take the bridge token or owner socket. Bhai stays on its own tab when the owner switches tabs. Permission rationale: `chrome-extension/PERMISSIONS.md`.

### Admin Dashboard / Scripts / Docs
- `admin-dashboard/index.html` — single-file static dashboard (separate from `portals/admin-panel/`)
- `scripts/` — Swift helpers (`get_location.swift`, `ocr_screen.swift`), vision overlay `som_overlay.py` (the os_screenshot grid is in-process: `src/screen/grid-overlay.ts`), OS hotkeys, Convex seeds, `patch-baileys.sh`; `docs/` — internal docs

### Configuration
- `.env` (see `.env.example`). Required: `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`, `ATLAS_OTPLESS_USER_ID`. Optional: `EMAIL_USER`/`EMAIL_PASSWORD`, `EMAIL_WHITELIST`, `GITHUB_TOKEN`, `HF_TOKEN`, `MEMORY_DEBUG`.
- Voice: `LIVE_VOICE_NAME` (Gemini Aoede/Charon/Kore/Fenrir/Puck; OpenAI alloy/shimmer/echo), `LIVE_VOICE_BACKEND` (gemini-live/openai-realtime/hybrid)
- `ATLAS_ENV=prod` flips Convex dev (`avid-finch-726`) → prod (`avid-finch-726`); default dev. Override via `CONVEX_URL`/`CONVEX_SITE_URL`. Convex keys bundled (not user-configurable). LLM calls go to the Claude API (`ANTHROPIC_API_KEY` in Convex env); `convex/claude.ts` translates the OpenAI-format requests.

**Personality presets** (Settings → Personality; wizard Personalize step): casual_playful, professional_concise, warm_supportive, direct_terse, unhinged (18+, owner-only). The choice is written to `<userData>/.user-personality.json`; the bot (`src/setup/personality-sync.ts`, path from `ATLAS_USER_DATA_DIR`) watches it and pushes the `user-personality` addendum instantly, which `convex/systemContent.ts` renders as its own "Tone the user chose in Settings" section; `agent.ts` also restates non-default tones next to the owner's message each turn. Bhai's character (English-first, a few Hindi signature phrases, Hinglish only when mirrored) lives in `prompts/identity.md`.

**System prompts are SERVER-SIDE**: Convex `system_prompts` table, seeded from `prompts/` via `scripts/seed-system-content.ts` (needs `ADMIN_API_KEY`). Client never reads disk — `src/config/system-prompts.ts::fetchSystemPrompt(slug)` pulls via `/api/system/prompt?slug=` (coalesced + single-flight auth refresh). Desktop electron-builder does NOT bundle `../prompts`. Seeded slugs (13): `identity`, `rules`, `rules-mac`, `rules-windows`, `browsing`, `coding`, `spec`, `proactive-composer`, `monitor-rule-parser`, `orchestrator-base`, `site-skill-mint`, `site-skill-review`, `unhinged`.

Skills loaded from `skills/` (12 role MD + 5 Convex skill dirs) and `~/.atlas/store/skills`. gray-matter frontmatter defines role/triggers/instructions. Server-side via `system_skills` table.

### Env Kill-Switches
Default ON unless marked opt-IN. Set `"true"` to disable. `grep -rnE "process\.env\.ATLAS_" src/` for call sites.

**Coding / agents:**
- `ATLAS_NO_CODING_ESCALATION` — disables `maybeEscalateForCoding`; `ATLAS_NO_CODING_THINKING` — no extended thinking on Pro coding
- `ATLAS_NO_CODER_SPECULATION` — no racing alt approaches; `ATLAS_WAVE_SPECULATION_CAP` — int (default `1`) or `"off"`
- `ATLAS_AGENT_WORKTREE` — opt-IN worktree isolation; `ATLAS_NO_AGENT_WORKTREE` — force-off override
- `ATLAS_DISABLE_BUILTIN_HOOKS` — drop built-in LSP-pre-edit hook; `ATLAS_NO_CODE_CRITIC` — skip swarm-synthesis critic
- `ATLAS_NO_POST_EDIT_DIAGNOSTICS` — no auto LSP diagnostics; `ATLAS_NO_SAST` — skip Semgrep
- `ATLAS_POST_SYNTHESIS_BUDGET_MS` — critic+MoA+verifier wall-clock cap (default 90000); `ATLAS_AUTO_PLAN_MODE` — opt-in auto plan mode
- `ATLAS_SWARM_DEEP_PLANNING` — opt-IN hierarchical planning + logic verification + MCTS refinement in `swarm.ts` (`src/planning/`)
- `ATLAS_NO_LEARNED_ROUTER=true` — disables the learned model router (see Model Router); turns fall back to the task-tier rules.
- `ATLAS_NO_QUICK_COMMANDS=true` — disables quick commands (`src/quick-commands.ts`). Default ON: an owner text turn made only of everyday commands (volume/mute, dark/light mode, open a settings page, play X on Spotify/Apple Music, pause/next/previous, open/quit an app, lock screen; chained with ","/"and"/"then") runs straight through `executeTool` with no model call (~0.3-4s, $0). All or nothing, checked before anything runs; a failed step hands the rest to the model with what already ran.
- `ATLAS_NO_GUI_FASTPATH=true` — disables the simple-GUI/messaging orchestrator skip. Default ON: a single-target OS/app/messaging/media action (cats ⊆ {os_control,app_management,communication,media,system_controls}, not chained, conf≥0.7) SKIPS the ~14K-token ~20s Sonnet plan. Complex/chained/browser/coding/research still plan. `ATLAS_ALWAYS_ORCHESTRATE=true` also disables it.
- `ATLAS_NO_WHATSAPP_TOOL_GATING=true` — restores offering `whatsapp_send`/`whatsapp_sticker`/`whatsapp_group_info` when Baileys isn't connected. Default OFF: those tools are hidden (via `isToolOfferable`) when `getWhatsAppStatus() !== "connected"`, re-evaluated per message so they reappear once linked.

**Model routing / cost:**
- `ATLAS_LLM_ATTEMPT_TIMEOUT_MS` — per-attempt LLM HTTP timeout (`crypto-transport.ts`, default `25000`); each fallback hop gets a fresh `AbortSignal.timeout`. Raise for slow max-thinking calls.
- `ATLAS_TOOL_ROUTER_TIMEOUT_MS` — LLM-classifier timeout (`tool-router.ts`, default `5000`); falls back to structural routing on timeout.
- `ATLAS_NO_COST_ROUTING` — disables the cost-aware routing net (`selectModel`). Default ON: caps plain single-turn chat (`first_iteration`/`simple_chat`) at Sonnet (never Opus). Cheap down-routing lives in native `select_dynamic_model` (needs `build:native`); this flag only disables the TS Opus-cap net. User-facing tiers: `pn≤3 & score≤15`→gpt-5-nano, `pn≤4 & score≤25`→gpt-5-mini, else Haiku→Sonnet→Opus (Opus gated to ComplexChat/explicit-complexity). Cost tables synced across `model_router.rs`, `llm-middleware.ts` MODEL_COSTS, `convex/credit_cost.ts`.
- `ATLAS_NO_DYNAMIC_ORCHESTRATOR` — forces every plan to Sonnet. Default OFF (dynamic ON). The plan call (`needsPlanning && iterations===1`) picks via `classifyOrchestratorComplexity()`: simple→Haiku (thinking off), mild→Haiku (low), complex→Sonnet (low). The plan call sends `serverPromptSlug: "orchestrator-base"`, which the proxy serves as rules + that slug (not the full identity stack). Bypasses `selectForPlanning`; cheap-tier failure one-shot-retries on Sonnet before the planless `catch`. DeepSeek added to native failover chain (needs `build:native`).
- `ATLAS_ORCH_SHADOW=true` — logs chosen tier to `data/orchestrator-routing.jsonl` but routes to Sonnet regardless. Default OFF. Routing always logged (`orchestrator-routing-log.ts`). Verify: `jq -r .complexity data/orchestrator-routing.jsonl | sort | uniq -c`; alert on `complex<2%` (classifier collapse).
- `ATLAS_NO_DYNAMIC_BROWSER_ROUTING=true` — restores "any action browser/OS tool → Sonnet". Default OFF (graduated ON). Native `browser_os` block (`has_action_browser_os && ToolLoop`) picks by complexity: complex→Sonnet (canvas/design via `is_creative_task`, OR `has_media`, OR `error_count>=2`, OR `browser_handle_captcha`, OR auth keywords); moderate→Gemini 3.1 Pro (`iteration>=3`/`adjusted_score>=45`); simple+vision→`gpt-5-mini`; simple text-DOM→`gpt-5-nano`. Pure navigation skips the block. Native fn sees only tool NAMES + message + iter/error/media, NOT results; `gpt-5-nano` has no vision. TS `maybeEscalateForBrowser` (gated by `ATLAS_NO_BROWSER_ESCALATION`) aligned; design-tool→Opus, stuck(`iter>=20`/`errors>=4`)→Opus. Needs `build:native`.

**Codebase index:**
- `ATLAS_NO_CODEBASE_INDEX` — `build` returns disabled; `ATLAS_NO_ARCHITECTURE_INJECTION` / `ATLAS_NO_REPO_MAP` — no first-iter `<architecture>`/`<repo_map>`
- `ATLAS_INDEX_DEPTH=symbols|imports|calls` / `ATLAS_INDEX_ASYNC=force|never` — override auto-pickers
- `ATLAS_CODE_PARSER=regex` — force legacy; `ATLAS_MULTI_TREE_SITTER=true` — opt-in Python/Rust/Go (crashes 0.22 binding)
- `ATLAS_TS_DEBUG=true` — verbose tree-sitter; `ATLAS_TOOL_DEBUG=off|verbose` — breadcrumb verbosity

**Proactive:**
- `ATLAS_PROACTIVE_DISABLE` — kill all sends; `ATLAS_PROACTIVE_DISABLE_SOURCES=csv` / `ATLAS_PROACTIVE_DISABLE_CHANNELS=csv` — silence sources/channels
- `ATLAS_PROACTIVE_SHADOW` — compose + log, don't deliver; `ATLAS_PROACTIVE_DEBUG=false` — suppress `🔔 [proactive]` logs

**Native ports (opt-IN unless noted):**
- `ATLAS_NATIVE_SPREADING` — opt-IN; SAN BFS (`native/spreading.rs`). Enable only for >1000-node fan-out (FFI dominates ≤150 nodes).
- `ATLAS_NO_NATIVE_SANITIZER` — disables native `sanitizeSecrets`/`containsSecrets`. Default native ON (re-measured Oct 2026: 1.9x-3.4x vs TS at 1KB-200KB after the TS ReDoS fix; 3.9x-7.9x against the pre-fix TS).
- `ATLAS_NATIVE_PROTECT` — opt-IN; linear-time `maskCredentials`/`findPii` (`pii_protect.rs`), byte-identical (`pii-protect.parity.test.ts`). Flip to `ATLAS_NO_NATIVE_PROTECT` once it is ≥3x the TS at 10KB and 200KB (Oct 2026, loaded machine: mask 2.6x-3.2x, findPii 2.5x-4x; adversarial 200KB 0.6ms vs 66ms).
- `ATLAS_NO_PROTECT_CACHE=true` — disables the `protect()` memo in `pii-vault.ts` (keyed by text + credential flag + vault generation; ~4M chars). Default ON; a pure memo.
- `ATLAS_NATIVE_VAD` — opt-IN; live-voice barge-in via libfvad (`pcm_vad.rs`), hybrid-mode only. Needs `vad` cargo feature (`npx napi build --features vad --release`); else RMS fallback. `ATLAS_VAD_MODE` 0-3 (default 2).
- `ATLAS_NATIVE_AX` — opt-IN; AX flatten/find (`ax_walker.rs`). Enable only for large AX trees (JSON round-trip dominates <200 nodes).

**Skill Forge:**
- `ATLAS_NO_FORGE` — disables Forge entirely; `ATLAS_NO_FORGE_LOOKUP` — disables lookup short-circuit; `ATLAS_NO_FORGE_AUTO_SYNTHESIS` — disables auto-queue
- `ATLAS_NO_FORGE_VERIFIER` — disables P3 verifier (`synthesizeTool` stub-inserts, `create_tool` skips forge, end-of-turn hook no-op)
- `ATLAS_NO_SYNTHESIS_ESCALATION` / `ATLAS_NO_SYNTHESIS_THINKING` — no-op escalation / skip thinking bump
- `ATLAS_FORGE_DREAM_OPUS` — Track B → Opus + max (else Sonnet + high); `ATLAS_FORGE_STUB_LLM` — **TEST-ONLY** stub row, never prod

**Memory write-gate:**
- `ATLAS_NO_MEMORY_GATE=true` — disables value-gate; `remember()` reverts to direct-write (emergency rollback).
- `ATLAS_MEMORY_GATE_SHADOW=true` (default during rollout) — decides + logs to `data/memory-gate.jsonl` but always inserts. Set `"false"` to enforce.
- `ATLAS_TRANSCRIPT_RETENTION_DAYS=N` — opt-IN; the decay pass deletes `conversations`/`conversation_messages`/`conversation_embeddings` older than N days. Unset keeps transcripts forever.

**Vision-nav:**
- `ATLAS_VISION_PROFILE=lite|standard` — override the profile (`src/screen/capability-detector.ts`). There is one setup for everyone (`standard`: accessibility tree → click memory → cloud grounding, no local ML download) and no tier picker in the wizard; `lite` only also skips OmniParser. The old `full` tier (Ollama + UI-TARS, ~4.5 GB) is retired; a stored `full` reads as `standard`.
- `ATLAS_NO_CLICK_MEMORY` — disables `src/screen/click-memory.ts`; rules out poisoned `data/click-memory.db`
- `ATLAS_NO_DRIFT_CALIBRATION` — disables `src/screen/drift-calibration.ts`; rules out bad affine fit
- `ATLAS_NO_CLOUD_GROUNDING` — disables the cloud grounding tier (`cloud-grounding.ts`: one Haiku call, Sonnet on a verified-miss re-ground, low thinking, grounding-only system prompt, 30s timeout). Default ON; the last cascade tier after AX/OmniParser miss. The screenshot is downscaled to ≤1568px (`downscaleForVision`) and coordinates are scaled from the image actually sent. `os_smart_click` auto-captures a window-scoped screenshot (`screencapture -R`) so vision tiers always have an image.
- `ATLAS_NO_AGENT_CURSOR=true` — no ghost cursor / "Bhai is in control" edge glow. Default ON when the desktop app spawned the bot (`ATLAS_AGENT_CURSOR_IPC=1`; standalone bot = no-op). Computer-use tools emit `##BHAI_CURSOR##{json}` stdout lines (`src/screen/agent-cursor.ts`); `desktop/agent-cursor.js` draws one click-through window per display (made hidden at app ready, synced on display changes) and acks on the bot's stdin. Off on Linux (no opacity/content protection there). The glow ends when the last turn that drove the screen ends. Captures run inside `withCursorHidden()` (hide → ack ≤150ms → capture → show); glides wait ≤300ms. Shared name with the browser cursor.
- `ATLAS_NO_WINDOW_SCOPED_CAPTURE` — forces `os_smart_click` to full-screen capture (macOS). Diagnostic for coord-offset issues.
- OmniParser tier: runs only when its deps, icon_detect weights AND Florence caption weights (`omniParserCaptionsPresent()`) are present. No install ships them any more (the old Standard tier's ~500 MB never included captions, so it never ran).
- `ATLAS_NO_OMNIPARSER=true` — force-skip the OmniParser cascade tier regardless of weights.
- `ATLAS_NO_AX_RETRY=true` — disables cold-window AX re-dump retry (`perception-router.ts`); `ATLAS_AX_RETRY_DELAY_MS` tunes settle delay (250ms). Re-dumps once after both AX tiers miss (freshly-activated windows often have incomplete trees).
- `ATLAS_NO_AX_BATCH=true` — back to one IPC per attribute. Default ON (parity identical on the owner's Mac, Oct 2026: Finder 542 nodes 2.1x, Chrome 3930 nodes 2.3x; a busy Finder cut the per-attribute walk at its 3 s budget after ~80 nodes, batched got all 541): `scripts/dump_ax.swift` reads each node's attributes (all but AXValue) with one `AXUIElementCopyMultipleAttributeValues` instead of one IPC each (~2-3.5x faster dumps on Finder/Chrome/System Settings). Parity: `npx tsx scripts/ax-parity.ts [--hang]` + `src/screen/__tests__/ax-batch.parity.test.ts` (live Finder part only with `ATLAS_AX_LIVE_TESTS=true`). AXValue stays a per-node read so a secure field's value is never requested.
- `ATLAS_AX_MSG_TIMEOUT_MS=N` — opt-IN per-call AX messaging timeout in `dump_ax` (clamped 100-5000; unset = system ~6s, the old walk exactly). One slow call is skipped and the walk goes on; two timeouts in a row end it (hung app → ~2N ms). Timeout or not, the whole walk stops at a 3 s budget (`budgetMs`; near the end the per-call timeout shrinks to what is left), so a slow or hung app returns a partial dump instead of hitting ax-dump.ts's 5 s exec kill. Batched reads never ask a known-slow attribute twice (slow whole-batch failure → structural attributes only, labels lost). Any lost read sets top-level `"partial": true`, which `perception-router` treats as an AX miss (vision fallback) and `os_inspect` flags in its hint.
- `ATLAS_NO_SMARTCLICK_VERIFY=true` — disables post-click verification of VISION-tier clicks. Default ON: before/after capture + `classifyOutcome`; `no_op`/`wrong_target` → click-miss + `click_unverified`. AX/memory tiers stay trusted.
- `ATLAS_NO_SMARTCLICK_SELFCORRECT=true` — keeps verification but disables the one-shot self-correction (re-ground past failed tier) on a miss.
- `ATLAS_SMARTCLICK_USE_CALLER_SCREENSHOT=true` — restores trusting caller-passed `screenshot_base64`. Default OFF: smart_click re-captures a fresh window-scoped frame at click time (callers passed STALE pixels → misclick); caller base64 last-resort only.
- `ATLAS_NO_UITARS_DOWNSCALE` / `ATLAS_UITARS_KEEP_ALIVE` — only affect `groundClick` in `ui-tars.ts`, used by the `os_ground` tool, which is no longer offered (no install ships UI-TARS).

**AX path resolution + label extraction (keystone, June 2026):** Packaged app is a single esbuild bundle (`Contents/Resources/bot/bot-bundle.mjs`), so `__dirname=.../bot` (flat). Old `projectRoot()` overshot to `Contents/` and missed helper scripts (`<Resources>/bot/scripts/`), so `dump_ax_bin`/`dump_uia.ps1`/`dump_atspi.py` never resolved → AX tiers skipped → every click forced to slow vision. Fixed by bundle-aware `getScriptsDir()`/`resolveScript()` in `src/config/paths.ts` (reused by `ax-dump`, `omniparser`, `macos`, `linux`). SEPARATELY, AX rows returned EMPTY labels (text in child `AXStaticText`); `flattenInteractiveJs` derives labels via `deriveLabelFromDescendants`, and `scoreText` is token-aware. Net: Finder "Downloads" 49s miss → 1ms `ax_fuzzy` hit.

### Rust expansion — empirical lessons (May 2026)

Original "more Rust = more speed" plan didn't hold. Captured so contributors don't re-run failed experiments.

**Rust wins (ship):** Multi-pattern regex sweeps over KB-scale inputs — sanitizer fires 23 patterns over 1KB-200KB; Rust sequential `regex::find_iter` + `Cow<&str>` wins 1.9×-3.4× (re-measured Oct 2026 against the ReDoS-fixed TS; 3.9×-7.9× before it). Linear time is a separate win: V8 regexes backtrack, and `maskCredentials` was quadratic (9s at 40KB) until the regexes stopped rescanning runs (no length bounds, which would cost real credentials; `src/security/__tests__/redos.test.ts`). Pattern ordering is load-bearing for parity (sequential, NOT alternation); lookahead emulated with post-match prefix check.

**Rust loses (don't port):**
- **Hardware-accelerated Node.** `node:crypto` SHA-256 uses OpenSSL + SHA-NI; Rust `sha2` is software-only, 2-4× SLOWER. Codebase-merkle reverted.
- **Small per-call inputs over FFI.** napi crossing ~500ns-3μs; for modules at 1-15μs/call (json-extract, smart-truncate, smartChunkMessage) FFI tax is a meaningful fraction. Wash or slower.
- **Graph BFS at small scales.** ≤150-node graphs lose 5×-300×+ to TS. Typed-napi ~15% slower than JSON. `nativeSpreadActivationBfsTyped` parity-tested but unused.
- **Already-fast file I/O + regex.** repo-map scan (~1000 files) is 38ms in TS; Rayon shaves ~25ms — not worth the port.

**Rule:** Time TS first. Port only when (a) TS is genuinely slow (>>100μs/call AND hot path) AND (b) Rust has a structural advantage (multi-pattern scanning, or parallelism). Otherwise FFI tax + maintenance = net negative. Caveat: this is the perf rule; correctness/safety wins (tree-sitter 0.22 bug) are separately justified.

**Rollout:** New ports ship with opt-IN kill-switch (off day 1); after `scripts/bench-native.ts` shows a win AND parity passes byte-identical, flip default ON (rename `ATLAS_NATIVE_X` → `ATLAS_NO_NATIVE_X`). Every native module ships a per-case bench + in-process parity vitest (`*.parity.test.ts`) on every `npm test`.

## Key Patterns

- **ES Modules** throughout (`"type": "module"`, `NodeNext`)
- **Fail-open**: Native unavailable → JS fallback; memory crash → continue without persistence; tool missing → skip
- **Semantic over keyword**: Tool selection, query classification, memory recall all use embeddings + cosine
- **Parallelization with ordering**: Memory retrieval parallel; browser tools sequential, others parallel; boot I/O non-blocking where possible
- **Token budget injection**: Memory snippets capped (traits: 600 tokens, total: ~2-3K)
- **Cascade escalation**: Errors → upgrade model tier (works in sub-agents too)
- **Multi-layer caching**: LLM responses semantic-cached; tool results per-tool TTL; memory queries via the temporal LRU cache
- **Graceful shutdown**: all subsystems have cleanup handlers
- **Dependency injection**: `LLMClient` created once at boot, passed in — never a singleton
- **OpenAI-compatible types**: all LLM uses `openai` types (`ChatCompletionMessageParam`, `ChatCompletionTool`) since Convex proxies via OpenRouter
- **Copyright headers**: all sources carry `© 2024-2026 XAGI Labs Private Limited`
- **Plan-mode state is a runtime gate**: `plan`/`spec`/`awaiting_approval` each have `*_ALLOWED_TOOLS` in `plan-mode.ts`; `filterToolsFor*` strips BEFORE the LLM call; `checkWritePathInApprovalMode()` enforces at execution. New state: extend union, add allowlist + filter fn, wire into `isToolAllowedInCurrentMode`.
- **Structured debug logs**: coding tools emit `logToolAction()`; silence with `ATLAS_TOOL_DEBUG=false`.

<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->
