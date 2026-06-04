# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A.T.L.A.S (v0.2.0) is a continuously running, proactive personal AI agent built with Node.js/TypeScript (~385 .ts files) + a native Rust performance layer (~49 .rs files). It provides autonomous computer use, deep research, and long-running async workflows via Telegram, Discord, Slack, Matrix, WhatsApp, desktop overlay, and email channels.

## Build & Run Commands

```bash
npm run dev              # Development with tsx --watch
npm run build            # TypeScript → dist/ (postbuild copies overlay.html)
npm start                # Run production build
npm run build:native     # Build Rust native module
npm run build:ocr        # Compile Swift OCR helper (macOS only)
npm run build:location   # Compile Swift CoreLocation helper (macOS only; predev hook)
npm run build:all        # Build native + OCR + location + TS
npm run lint             # Biome check
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
npm run test:watch       # vitest watch

# Convex backend
npx convex dev
npx convex deploy

# Desktop app (Electron 40+, electron-builder)
cd desktop && npm start
cd desktop && npm run build:mac   # macOS DMG (uses create-dmg.sh)
cd desktop && npm run build:win   # Windows NSIS installer
```

Requires Node.js >= 20. Testing via Vitest. No CI/CD pipeline. Build is `tsc` + native Rust compilation.

## Architecture

### LLM Client (`src/llm.ts` + `src/crypto-transport.ts`)
All LLM calls proxy through Convex — client never holds API keys. `createLLMClient()` returns an `LLMClient.chat()` that builds messages with dynamic context, sends to `${convexSiteUrl}/api/llm/chat` via ECDH P-256 + AES-256-GCM (`encryptedFetch()`) on top of HTTPS. Server prepends its own system prompt (`convex/systemContent.ts`) before the LLM provider.

Models in `MODELS` constant (Opus, Sonnet, Haiku, GPT-5.x, Gemini). `LLMClient` is injected into agent, tools, swarm, research.

Client-side layers in `.chat()`:
- **Semantic response cache** (`llm-cache.ts`) — Embedding cache (cosine ≥ 0.88, 10min TTL, 200 LRU). Threshold lowered from 0.95 to reduce false negatives; tool-state not in cache key. Only caches simple queries without tool calls or thinking.
- **Adaptive language matching** (`language.ts`) — Unicode script + keyword heuristics; injects "Respond in {language}". Devanagari, CJK, Cyrillic, Arabic, Hangul, Thai, Latin (Spanish/French/German/etc.) including Romanized Hindi/Hinglish.

### Boot Sequence (`src/index.ts`)
1. Session + Auth: `initSession()` → `initAccountGuard()` verifies credits
2. Memory: SQLite, knowledge graph, traits, emotional, episodic, self-state
3. Async warmup (non-blocking): `warmupEmbeddings()`, `embedExistingMemories()`
4. Tool infra: MCP, skills, browser memory, Docker sandbox, tool router (pre-computes category embeddings)
5. Channels: Canvas WS, Google APIs, overlay chat, email (IMAP/SMTP), Telegram
6. Scheduled: heartbeat, memory decay (6h), dream replay (nightly 3am)

### Agent Loop (`src/agent.ts:390` — `runAgent()`)
1. Account gate (credits)
2. Message preprocessing + context pruning
3. **First iteration**: ~12 memory retrieval systems fire (identity, traits, session summary, self-state, emotional, episodic, relationship, anticipation, core memory, query-specific recall, task learnings, KG entities). Three primary queries — semantic recall, conversation recall, task learnings — run in one `Promise.all`. Budget ~2-3K tokens.
4. **Each iteration**: `chooseModel()` (native Rust router) → semantic tool selection → LLM call → tool execution → completion check
5. Browser tools sequential (shared page state); others parallel
6. Cascade escalation on errors (Haiku → Sonnet → Opus)
7. Max 200 iterations; credit check every 5 tool calls

### Model Router (`src/model-router.ts` + `native/src/model_router.rs`)
TS wrapper around napi-rs native binary. Decision factors: iteration count, errors, last tool calls, media, user hint. Tiers:
- **Light** (0.25 cr): Haiku/Flash — casual chat, simple retrieval
- **Pro** (1 cr): Sonnet/GPT-5.3 — browser automation, tool calling
- **Heavy** (3 cr): Opus/GPT-5.4 — complex reasoning, deep research

Falls back to JS-only if native fails.

### Tool Router (`src/tool-router.ts` + `src/tool-router-analytics.ts`)
Semantic selection via MiniLM embeddings (384-dim). Boot: embed each category description. Per-message: embed query → cosine top-K → load category schemas. `request_tools` meta-tool expands mid-task. 20+ categories. **FunctionGemma fallback** (`src/models/function-gemma.ts`): optional local 270M via Ollama for zero-cost routing. Analytics track usage/accuracy/hit rates.

### Memory System (`src/memory/` — 39 files)
All local SQLite (`data/memory.db`):
- `sqlite.ts` — Primary store: `remember()`, `recall()`, `getCoreMemory()`
- `knowledge-graph.ts` — Entity-relationship graph
- `vector-index.ts` — HNSW ANN for semantic recall
- `reflection.ts` — Nightly dream replay; decay every 6h
- `task-learnings.ts` — Strategies for recurring tasks
- `identity.ts`, `traits.ts`, `emotional.ts`, `episodic.ts`, `self-state.ts`, `session.ts`, `relationship.ts` — Specialized tiers
- `working-memory.ts`, `hopfield-memory.ts` — Short-term + associative
- `world-model.ts`, `user-model.ts`, `active-inference.ts`, `counterfactual.ts`, `prospective.ts` — Predictive reasoning
- `sleep-gate.ts`, `surprise-gate.ts`, `reranker.ts`, `strategy-library.ts` — Consolidation + retrieval
- `classifier.ts`, `context-pruning.ts` — Query classification, context window
- `goals.ts`, `self-evolving.ts`, `self-model.ts`, `memory-informed-planning.ts` — Goals + self-model
- `consolidation.ts`, `multimodal.ts`, `temporal-cache.ts`, `embeddings.ts`, `multimodal-embedding.ts`

### Channel Flow (Telegram: `src/telegram.ts`)
```
Message → User whitelist → Media extraction → runAgent() → Streaming
→ smartChunkMessage() (sentence boundaries) → Markdown→HTML → Send
```
Internal tags (`<system_log>`, `<tool_log>`) stripped before send.

### Convex Backend (`convex/`)
API key proxy + auth + store backend — LLM keys never reach client:
- `http.ts` — HTTP actions proxy LLM calls with E2E encryption
- `sessions.ts` — Session tokens (24h TTL, ECDH shared key)
- `accounts.ts` — Credit tracking, atomic deduction; plans: free/pro/enterprise
- `crypto.ts` — Server-side ECDH + AES-256-GCM
- `systemContent.ts` — System prompt assembly (server-side)
- `schema.ts` — `accounts`, `sessions`, store tables (`developers`, `admins`, `store_items`, `submissions`, `store_installs`, `store_reviews`, `store_activity_log`), system content tables (`system_prompts`, `system_skills`)
- `convex/store/` — Store CRUD (`items.ts`, `submissions.ts`, `developers.ts`, `storage.ts`, `admins.ts`, `installs.ts`, `reviews.ts`)

### Native Rust Layer (`native/src/` — 49 .rs files)
SIMD-accelerated vector ops (~15-20x speedup) via napi-rs. Built with `opt-level=3`, LTO, `panic=abort`, stripped. Deps: `wide` (SIMD), `simsimd`, `rayon`, `aes-gcm`. Modules mirror TS counterparts; `lib.rs` is napi entry, `chrome_bridge.rs` is extension bridge.

### Agent Orchestration (`src/agents/` — 30 files)
Four-tier execution model:

**Core Tiers:**
- **Sub-Agent** (`sub-agent.ts`) — Specialized roles (researcher/coder/browser/system/general); scoped tools, loop detection, error-driven escalation, `request_tools` expansion, priority-based timeout/model, partial streaming, per-iteration cost
- **Swarm** (`swarm.ts`) — Decomposes into sub-agent steps (max 20), executes via Mesh, evaluator-optimizer loop + replanning, integrates task learnings. Triggered by `swarm_task`
- **Mesh** (`mesh.ts`) — Parallel DAG: critical path, layered recovery (retry→rephrase→reroute→skip), structured handoffs, dynamic role assignment
- **Long-Task** (`long-task.ts`) — 200 iter/phase, 30min timeout, max 100 phases. Checkpoints to `data/long-tasks/${taskId}.json` every 60s; max 3 inter-phase replans

**Reliability:** `error-recovery.ts` (retry→rephrase→reroute→skip), `error-types.ts` (`ErrorCategory` enum), `smart-truncate.ts` (tool-specific: shell tail-heavy, JSON parse+prune, browser keep IDs, files head+tail), `handoff.ts` (300-char summary, 5 findings, artifacts, errors)

**Optimization:** `evaluator.ts` (0-100 scoring + retry), `replanner.ts`, `role-analyzer.ts` (overrides LLM roles when confidence > 0.7), `mixture.ts` (MoA, ≥5 steps), `speculative.ts` (races approaches), `decomposition-library.ts` (`data/decomposition-templates.json`), `blackboard.ts`, `complexity-classifier.ts`

**Self-Improvement / Specialized:** `metacognition.ts`, `multi-critic.ts`, `code-critic.ts` (compile+test+lint+SAST+ui_verify, fires `swarm.ts:~215` for coder steps, weights 0.4/0.4/0.2/0.15, budget `ATLAS_POST_SYNTHESIS_BUDGET_MS` default 90s), `agent-worktree.ts` (opt-in `ATLAS_AGENT_WORKTREE=true`, allocates `data/agent-worktrees/<id>/` when ≥2 coders race, rewrites file paths), `textgrad-refiner.ts`, `self-editor.ts`, `self-heal.ts`, `code-action-agent.ts`, `computer-use-agent.ts`

### Coding Agent Pipeline (`src/tools/coding/` — 25+ files)
Staged pipeline with runtime gating. Read before touching `src/tools/coding/` or `src/agents/plan-mode.ts`.

**Complexity classification** (`src/model-router.ts::classifyCodingComplexity`): on first iteration, regex classifier returns `"trivial" | "standard" | "complex"`; `src/agent.ts` injects `<coding_complexity>` reminder. Trivial skips Pro tier and docs ceremony. Standard implements on Pro. Complex (refactor/new-system/build-verb + high-stakes-domain / >400 chars) fires full design-docs flow.

**Pro-tier routing** (`maybeEscalateForCoding`): non-trivial coding forces tier ≤ 4 (Sonnet/Opus/Gemini Pro/Nova Pro). Tiers are inverted: 0=Opus, 2=Sonnet, 3=Gemini Pro, 4=Nova Pro, 5=Haiku, 6-9=lighter. `PRO_TIER_CEILING = 4`. `selectForSubAgent(..., role)` pins coder sub-agents to Pro. Extended thinking lifts unless `ATLAS_NO_CODING_THINKING=true`.

**Complex-task flow:**
1. **Design docs** — `generate_design_docs({ task })` writes PRD.md + TECHNICAL.md + ARCHITECTURE.md under `A.T.L.A.S Files/Documents/design-docs/<slug>/`. In-tool Sonnet call with `responseFormat: "json_object"`; falls back to scaffolded templates. **Auto-transitions plan-mode to `awaiting_approval`** — implementation runtime-blocked.
2. **Approval gate** — `awaiting_approval` is the fourth plan-mode state (alongside `act`/`plan`/`spec`). Allowlist `AWAITING_APPROVAL_ALLOWED_TOOLS`: reads, `edit`/`write` restricted to design-docs dir via `checkWritePathInApprovalMode()`, channel senders, `render_md_to_pdf`, `approve_design_docs`, `generate_design_docs`. `shell_exec`/`test_run`/arbitrary `edit` refuse at tool layer. User approval → agent calls `approve_design_docs({ user_quote })` (quote required for audit) → `act` mode.
3. **Implement** — standard coder loop on Pro. Worktree isolation if `ATLAS_AGENT_WORKTREE=true` AND ≥2 parallel coders.
4. **Walkthrough** — `demo_project({ project_dir })` auto-detects stack, launches runtime. Agent calls `browser_verify`/`os_screenshot`/`screen_record`, then `generate_walkthrough()` reads `git log` + `git diff` → WALKTHROUGH.md. Delivery: overlay (inline MD + screenshot), TG/WA (PDF + screenshot/MP4), Discord/Slack (attach MD).

**Write-path gating** (runtime): `edit.ts` and `write.ts` call `checkWritePathInApprovalMode(filePath)`. In `awaiting_approval`, only `designDocsDir` paths pass.

**Debug logs** — coder sub-agent tool calls emit breadcrumbs via `src/utils/debug-log.ts::logToolAction({ tool, filePath, line, action, context })`. Format: `🔧 [tool] sub_agent=id role=r | path:line — action`. Silenced with `ATLAS_TOOL_DEBUG=false`.

### Codebase Comprehension (Phase 4L — `src/memory/codebase-*` + `src/tools/coding/codebase-*`)
Per-repo SQLite sidecar under `data/codebase-index/<repo-hash>.db`. Distinct from `memories.db`. Auto-built on first coding iteration.

- **`codebase-sidecar.ts`** — Schema `4L.3`. Tables: `files`, `symbols`, `imports`, `calls`, `parse_errors`, `index_meta` + `symbols_fts` FTS5.
- **`codebase-merkle.ts`** — SHA-256 + repo-root resolution; incremental refresh skips unchanged files.
- **`code-parse/`** — Language dispatcher. `tree-sitter-extractors.ts` default for TS/JS (tree-sitter 0.22.4 + tree-sitter-typescript 0.23.2); `regex-extractors.ts` fallback covers 15 langs. Python/Rust/Go grammars gated behind `ATLAS_MULTI_TREE_SITTER=true` (0.22 native binding has multi-grammar collision bug). `ATLAS_CODE_PARSER=regex` forces legacy. Max file size 500KB.
- **`codebase-index.ts`** — `buildIndex`/`refreshIndex`/`getIndexStats`/`wipeIndex`. `pickDepth()`: ≤500 files → `calls`, ≤5000 → `imports`, else → `symbols`. `ATLAS_INDEX_DEPTH` overrides. `ensureIndexForCoding(root)` on first coding iter; `pickTiming()` (≤100 → block). `getArchitectureSnippet(root)` returns Mermaid + ASCII summary.
- **`codebase_query` ops** (`src/tools/coding/codebase-query.ts`): `find_symbol`, `find_usages`, `search` (BM25 FTS5), `ego_graph` (k-hop BFS from file:line), `file_neighborhood`, `describe_file`, `architecture_overview`, `dependency_chain`.
- **`codebase_index` commands**: `build`/`refresh`/`stats`/`wipe`. Uses raw better-sqlite3 (`getRawSidecar()`), not the wrapped helper (which routes to `memories.db`).
- **`self-evolving.ts`** — Nightly prune skips `category = 'code'` AND `category NOT LIKE 'code\_%'` so coding-strategies aren't aged-out. Add new coding-memory categories here too.

Read-side: `code_change_summary` (git: `recent_commits`/`hot_files`/`diff`/`blame`), `agents_md_scaffold` (AGENTS.md + 8 sub-docs with `<!-- @atlas:auto -->` markers), `lsp` with `getDiagnostics` consuming `textDocument/publishDiagnostics` — auto-attached to edit results as `post_edit_diagnostics` unless `ATLAS_NO_POST_EDIT_DIAGNOSTICS=true`.

Write-side: `git_op` with 4-tier safety (safe/confirm/destructive/blocked). Protected branches `main`/`master`/`production`/`release/*` + evidence-phrase gate for `push --force` AND `push --force-with-lease`. Ephemeral `checkpoint`/`restore_checkpoint` via `git stash create`.

### Workspace & Artifact Outputs (`src/config/paths.ts`)
User-facing artifacts under workspace root via `getWorkspaceDir()`:
- Primary: `$ATLAS_WORKSPACE` (set by desktop installer)
- Fallbacks: `~/Desktop/A.T.L.A.S Files` → `~/Documents/A.T.L.A.S Files` → `~/.atlas/files`
- Created on demand: `~/A.T.L.A.S Files`
- Last resort: `os.tmpdir()`

On-demand subdirs: `getCodeDir()` (default for `scaffold_project`), `getDocumentsDir()` (`design-docs/<slug>/` + `walkthroughs/<slug>/`), `getImagesDir()`, `getScreenshotsDir()`, `getDownloadsDir()`, `getTempDir()`.

Rule: tools writing user artifacts default to `getWorkspaceSubdir()`, only override when user names a path. `data/` is for ATLAS-internal state.

### Browser Tools (`src/tools/browser/` — 15 files; `src/tools/` has ~45 top-level, ~60 total)
Dual-backend. `BrowserBackend` interface (`browser-backend.ts`):
- **Playwright** (`playwright-backend.ts`) — Headless Chromium, persistent profile `data/browser-profile/`
- **Chrome Extension** (`chrome-backend.ts` + `chrome-bridge.ts`) — WS bridge to user's real Chrome; `ChromePageProxy` mimics Playwright Page API
- `stagehand-bridge.ts` — AI-native browser framework
- `mode-tools.ts` — Fast (DOM) ↔ vision (screenshot + OCR) mode switch
- `profile-sync.ts` — Browser profile sync
- 25+ actions: navigate/click/type/scroll/extract, parallel tabs/actions, upload, JS exec, strategy save/recall

### Tool Intelligence (`src/tools/tool-intelligence.ts` + `create-tool.ts`)
Per-tool caching (web_search 2min, read_file 1min, system_info 5min), rate limiting, audit log, confirmation gates. **Dynamic tools** (`create-tool.ts`) persist to `~/.atlas/store/tools` and hot-reload; handlers run in `vm.createContext` sandbox with restricted require shim.

### Skill Forge — Phase 4 persisted-tier sandbox (`src/forge/sandbox-supervisor.ts` + `native/src/forge_sandbox/`)

Persistent synthesized tools (`req.persistent === true`) live at `~/.atlas/store/dynamic/<slug>/{handler.js, manifest.json}` and execute inside OS-isolated Node child processes. The fence is the **kernel**, not the JS runtime — macOS sandbox-exec (SBPL profile written per-spawn at `.sandbox.sb`), Linux seccomp + Landlock + CLONE_NEWNET via pre_exec, Windows AppContainer + JobObject helpers (full spawn deferred). Rust supervisor: `forge_invoke_tool`, `forge_spawn_warm`, `forge_evict`, `forge_strikes`, `forge_clear_strikes`, `forge_set_pool_size` napi exports. Pool: LRU `tokio::sync::Mutex<LruCache>` cap 10, never evicts inflight workers. Three-strike auto-archive: 3 cap violations within `ATLAS_FORGE_STRIKE_WINDOW_MS` (default 1h) archives the slug; boot-failure burns all 3 at once. `approve_dynamic_tool({slug, user_quote})` flips lifecycle awaiting_approval → active and registers a closure handler that delegates to `invokePersistedTool`. `revoke_dynamic_tool` calls `forge_evict` + clears strikes + archives. Plan-mode state `awaiting_dynamic_tool_approval` gates the agent to the approval/revoke tools only. Boot-scan in `initForge` re-registers approved manifests. 15-pattern adversarial regression suite (`src/forge/__tests__/capability-bypass.test.ts`) locks defeated bypass classes (fs.promises, process.binding spawn_sync, http/net/tls/dgram, dlopen, macOS case-bypass, copyFile/symlink, eval-based access, child_process.spawnSync, listen). Kill switches: `ATLAS_NO_FORGE_SANDBOX`, `ATLAS_FORGE_POOL_SIZE`, `ATLAS_FORGE_CALL_TIMEOUT_MS`, `ATLAS_FORGE_STRIKE_WINDOW_MS`, `ATLAS_FORGE_LANDLOCK_OPTIONAL`, `ATLAS_FORGE_STRICT`, `ATLAS_FORGE_LINUX_NET_PASSTHROUGH`, `ATLAS_FORGE_WINDOWS_STRICT`. Phase 4 design doc: `docs/superpowers/specs/2026-05-16-forge-sandbox-rust-supervisor-design.md`.

### Skill Forge (`src/forge/` — Phases 1+2+3 shipped)
Dynamic-tool reliability layer. P1: foundation (SQLite library, manifest, hot-reload). P2: lookup-first short-circuit so `create_tool` reuses before synthesizing. P3: closed-loop verifier — LLM generates `{handler_code, tests, capabilities_declared, side_effects, synthesis_notes}` envelope; sandbox runs tests; critics check compile + lint + SAST; diagnose prompt drives retries up to 3× (Track A/sync) or 10× (Track B/dream-replay). Pro-tier via new `tool_synthesis` TaskType (Sonnet default; Opus + max with `ATLAS_FORGE_DREAM_OPUS=true`).

Lookup pipeline: FunctionGemma 270M (zero cost when Ollama+model present) → FTS5 BM25 over description+schema_keys → cosine rerank (threshold 0.85). Dedup at write time at 0.85/0.92 (warn vs merge).

Verifier (`src/forge/verifier.ts`): `parseEnvelope` → `runCompileCheck` (acorn, hard-fail) → `runSastCritic` (11 regex rules) → `runTestInSandbox` per test (vm.createContext, 10s each) → `scoreResult` against `expected_kind` (8 variants: returns_equals/contains/matches_regex, throws/throws_contains/no_error, side_effect_*). Failures build `buildDiagnosePrompt` + retry. Cap via `ATLAS_POST_SYNTHESIS_BUDGET_MS` (90s). Failures → `~/.atlas/store/dynamic/_failed/<ts>_<slug>.json` (BigInt/circular/Symbol-safe stringify).

Public API (`src/forge/orchestrator.ts`):
- `initForge({ embedFn })` / `isForgeReady()` / `getForgeStats()` / `shutdownForge()`
- `setForgeLLM(client)` — inject LLM (once at boot)
- `lookupTool(description, schema)` → `ToolMetadata | null` (P2)
- `synthesizeTool(req)` → `SynthesisResult` union (`lookup_hit` | `synthesized` | `awaiting_approval` | `failed`)
- `queueSynthesisCandidate(req)` / `consumeNextPendingCandidate()` (P2 queue)
- `runDreamReplaySynthesis` — P6 stub

Wiring:
- `src/forge/pending-consumer.ts::consumeOnePending()` — pulls one queued candidate, synthesizes
- `src/agent.ts` end-of-turn hook fires `consumeOnePending()` fire-and-forget (disable via `ATLAS_NO_FORGE_VERIFIER=true`)
- `src/tools/create-tool.ts` routes through `synthesizeTool` when ready; falls back to legacy registry on `ATLAS_NO_FORGE_VERIFIER=true` or offline

Router additions: `TaskType` extended with `"tool_synthesis"`; native enum `ToolSynthesis` + `task_model_map`/`task_type_to_str`/`task_thinking_map`. `maybeEscalateForSynthesis(base, isDreamReplay)` — Track A: Sonnet + high; Track B: Sonnet + high (or Opus + max if `ATLAS_FORGE_DREAM_OPUS=true`). `selectForToolSynthesis(isDreamReplay?)` is public entry. `selectForAgent` inserts synthesis escalation BEFORE browser/coding when `lastToolCalls` contains `create_tool`.

Spec: `docs/superpowers/specs/2026-05-15-forge-tool-creation-overhaul-design.md` (deep dives in `forge-deep-dives/`).

### Deep Research (`src/research/` — 11 files)
Background engine: `executor.ts` (up to 500 sources), `engines.ts` (search providers), `fetcher.ts` (HTML→text), `scoring.ts`, `persistence.ts` (`data/research/`), `hypothesis-engine.ts`, `credibility-model.ts`, `analysis.ts`, `profiles.ts`.

### Runtime Data (`data/`)
Gitignored. Internal state ≠ user-facing outputs (see Workspace section).
- `data/memories.db` — All memory subsystems
- `data/codebase-index/<repo-hash>.db` — Per-repo sidecars (Phase 4L)
- `data/agent-worktrees/<step-id>/` — Throwaway worktrees (Phase 4G; only with `ATLAS_AGENT_WORKTREE=true`)
- `data/long-tasks/` — Resumable task checkpoints
- `data/research/` — Research markdown
- `data/browser-profile/` — Playwright profile
- `data/google-credentials.json` + `data/google-tokens/`
- `data/proactive-config.json` — Per-channel posture, night windows, urgentAllowedAfter. Hot-reload.

### Social Cognition (`src/social/` — 1 file)
- `emotion-detector.ts` — zero-cost heuristic (lexicon + punctuation) → `{ primary, valence, arousal, signals }`. `src/prompts/dynamic-context.ts::buildDynamicContextReminder` bridges into `assembleDynamicPrompt`'s `userEmotionalState`; `src/agent.ts` injects on first iter. Removed stubs (`theory-of-mind`, `pragmatics`, `persuasion`) — LLM handles natively.

### Planning & Execution (`src/planning/` + `src/execution/`)
- `mcts-planner.ts` — MCTS (UCB1, scored by PRM); `hierarchical-planner.ts` — multi-level decomposition
- `process-reward.ts`, `logic-verifier.ts`, `pattern-speculator.ts`

### Local Models (`src/models/` — 5 files)
Zero-API-cost on-device:
- `function-gemma.ts` — 270M Ollama for tool routing (85% acc, falls back to LLM)
- `local-asr.ts`, `local-tts.ts`, `local-ocr.ts`, `local-vision.ts`

### Dynamic Prompts (`src/prompts/` — 3 files)
- `dynamic-assembler.ts` — Context-aware prompt assembly (task type, emotional state, relationship depth, hour-of-day)
- `prompt-evolver.ts` — Iterative refinement; `watermark.ts` — Response watermarking

### Alive UX + Network Health + Location
- **Alive UX** (`src/alive-ux.ts`) — Centralized personality/phrasing; prevents repetition, adapts tone
- **Network Health** (`src/network-health.ts`) — online/degraded/offline tracking; `isOnline()` gate; 45s passive / 15s recovery
- **Location** (`src/location/` — 7 files) — Singleton: GPS → Wi-Fi → IP; `network-watcher.ts` drives refresh; Swift helper on macOS

### Widget (`src/widget/widget.ts`)
Embeddable chat widget at `/widget.js` from overlay server. IIFE injects DOM + styles + WS logic; `?token=` auth; connects to overlay WS.

### Additional Subsystems
- **MCP** (`src/mcp/`) — `client.ts`, `gitmcp-bridge.ts` (exposed as `gitmcp_docs` via `src/tools/gitmcp.ts`)
- **Proactive** (`src/proactive/` — 28 files) — Heartbeat, behaviors, night dreaming. P0+1: `intent.ts`/`intent-from-thought.ts`, `composer.ts`/`composer-templates.ts` (template → LLM → banned-phrase + third-person filter), `dispatch.ts` (single exit, mode emoji 💡/❓/✅), `config.ts` (per-channel posture calm/active/ambient; `data/proactive-config.json`), `kill-switches.ts`. Plus: `goal-engine.ts`, `habit-detector.ts`, `inner-thoughts.ts`, `thought-journal.ts`, `trigger-detector.ts`, `notification-tracker.ts`, `environment-sensors.ts`, `proactive-reward.ts`, `dnd.ts`, `monitors.ts`, `activity.ts`, `recommendations.ts`
- **Security** (`src/security/`) — `sandbox.ts`, `allowlist.ts`, `secrets-sanitizer.ts` (scans tool results for keys before LLM), `audit-log.ts`, Docker isolation
- **Voice** (`src/voice/`) — `telegram-voice.ts`, `transcribe.ts`, `tts.ts` (`ATLAS_TTS_PROVIDER` → `ELEVENLABS_API_KEY` → `OPENAI_API_KEY`), `live/` (continuous voice)
- **Canvas** (`src/canvas/`) — WS canvas channel for rich UI
- **Commands** (`src/commands/`) — Slash-command parsing
- **Skills Loader** (`src/skills/`) — gray-matter frontmatter MD from `skills/` + `~/.atlas/store/skills`
- **Store** (`src/store/`) — `client.ts` (Convex-auth'd), `installer.ts` (download + extract + hot-reload; `Expand-Archive` Windows / `tar` elsewhere), `sideload.ts` (`sideload_skill`), `hot-reload.ts`. Read-only agent access via `store_browse` tool: search/list/info/featured/trending/categories/installed. Install/uninstall in desktop UI only.
- **Channels** — Discord (`src/discord.ts`), Slack (`src/slack.ts`), Matrix (`src/matrix.ts`)
- **Config** (`src/config/`) — `keys.ts`, `paths.ts`
- **Notifications** (`src/notifications/push.ts`)
- **LLM Middleware** (`src/llm-middleware.ts`)
- **Types / Utils** (`src/types/`, `src/utils/`) — Ambient types + utilities (`json-extract.ts`, `system-resources.ts`, `uuid.ts`)

### WhatsApp Channel (`src/whatsapp.ts` + `src/whatsapp-users.ts`)
Most privilege-differentiated channel. Baileys (`@whiskeysockets/baileys`). State in `data/whatsapp-users/` JSON (owners, contacts, personas, groups) — NOT `data/memories.db`.

**Identity tiers** (resolved per message):
- **Owner** — JID in `owners.json`; full tools, `isOwner: true`. In-memory history.
- **Allowed contact** — Owner-approved; persona-gated.
- **Unknown** — notifies owner; `autoAllow` promotes after delay.
- **Group** — JID `*@g.us`.

**Persona system**: Single global `whatsapp-persona.json` (name, system prompt, `allowedToolNames[]`). Applied to all non-owner. `whatsapp.ts:~933` hard-codes anti-impersonation rules (reject "I am the owner", refuse system actions on owner's behalf) — in code, NOT persona. Don't weaken.

**Groups**:
- **Add flow** (`groups.upsert`, `whatsapp.ts:1499`): owner in participants → auto-`active`; else → `pending`, DMs owner approve/decline. Silent until approved.
- **Lifecycle**: `pending` → `active` → optional `muted`. Commands: `approve X`, `decline X`, `groups`, `mute/unmute group X`.
- **Response gating** (`handleGroupMessage`, `whatsapp.ts:1033`): must be `active`; always respond if @mentioned/replied; else throttle (skip if <30s since last send OR bot >15% messages); then Haiku YES/NO chime-in (failure = silent).
- **Tool allowlist**: `senderIsOwner ? undefined : getPersona().allowedToolNames`.

### Web Portals (`portals/`)
Next.js + Tailwind, own `package.json` + `.env.example`:
- `portals/admin-panel/` — Manage users, store submissions, system prompts/skills
- `portals/developer-portal/` — Skill/tool/MCP publishing

### Overlay App (`overlay-app/`)
Native macOS Swift app (`Package.swift`) — distinct from inline `src/overlay/overlay.html`.

### Chrome Extension (`chrome-extension/`)
Companion for `src/tools/browser/chrome-backend.ts`. `background.js` (WS bridge), `content.js` (DOM), `popup.html`/`popup.js` (toggle). Drives user's real Chrome instead of headless.

### Admin Dashboard / Scripts / Docs
- `admin-dashboard/index.html` — Single-file static dashboard (separate from `portals/admin-panel/`)
- `scripts/` — Swift helpers (`get_location.swift`, `ocr_screen.swift`), vision overlays (`grid_overlay.py`, `som_overlay.py`), OS hotkeys, Convex seeds (`seed-store.ts`, `seed-system-content.ts`), `patch-baileys.sh`
- `docs/` — Internal docs (e.g. `docs/superpowers/`)

### Configuration
- `.env` (see `.env.example`)
- Required: `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`, `ATLAS_OTPLESS_USER_ID`
- Optional: `EMAIL_USER`/`EMAIL_PASSWORD`, `EMAIL_WHITELIST`, `GITHUB_TOKEN`, `HF_TOKEN`, `MEMORY_DEBUG`
- Voice: `LIVE_VOICE_NAME` (Gemini: Aoede/Charon/Kore/Fenrir/Puck; OpenAI: alloy/shimmer/echo), `LIVE_VOICE_BACKEND` (gemini-live/openai-realtime/hybrid)
- `ATLAS_ENV=prod` flips Convex client from dev (`zany-kudu-607`) to prod (`avid-oyster-465`); default dev. Override via `CONVEX_URL`/`CONVEX_SITE_URL`.
- OpenRouter and Convex keys bundled — not user-configurable

**System prompts are SERVER-SIDE**: in Convex `system_prompts` table, seeded from `prompts/` via `scripts/seed-system-content.ts` (needs `ADMIN_API_KEY`). Client never reads from disk — `src/config/system-prompts.ts::fetchSystemPrompt(slug)` pulls via `/api/system/prompt?slug=` with in-flight coalescing + single-flight auth refresh. Desktop electron-builder does NOT bundle `../prompts`. Seeded slugs: `identity`, `rules`, `rules-mac`, `rules-windows`, `browsing`, `thinking`, `coding`, `spec`.

Skills loaded from `skills/` (12 role MD + 5 Convex skill dirs: `convex-create-component`, `convex-migration-helper`, `convex-performance-audit`, `convex-quickstart`, `convex-setup-auth`) and `~/.atlas/store/skills`. gray-matter frontmatter defines role/triggers/instructions. Server-side via `system_skills` table.

### Env Kill-Switches
Default ON unless marked opt-IN. Set `"true"` (or sentinel) to disable. `grep -rnE "process\.env\.ATLAS_" src/` for call sites.

**Coding / agents:**
- `ATLAS_NO_CODING_ESCALATION` — disables `maybeEscalateForCoding`
- `ATLAS_NO_CODING_THINKING` — disables extended thinking on Pro coding
- `ATLAS_NO_CODER_SPECULATION` — disables racing alt approaches in `shouldSpeculate`
- `ATLAS_WAVE_SPECULATION_CAP` — int (default `1`) or `"off"`
- `ATLAS_AGENT_WORKTREE` — opt-IN; worktree isolation for parallel coders
- `ATLAS_NO_AGENT_WORKTREE` — force-off override
- `ATLAS_DISABLE_BUILTIN_HOOKS` — drop built-in LSP-pre-edit PreToolUse hook
- `ATLAS_NO_CODE_CRITIC` — skip critic in swarm synthesis
- `ATLAS_NO_POST_EDIT_DIAGNOSTICS` — no auto LSP diagnostics on edits
- `ATLAS_NO_SAST` — skip Semgrep in code-critic
- `ATLAS_POST_SYNTHESIS_BUDGET_MS` — critic+MoA wall-clock cap (default 90000); also caps verifier
- `ATLAS_AUTO_PLAN_MODE` — opt-in auto-entry to plan mode

**Model routing / cost:**
- `ATLAS_NO_COST_ROUTING` — disables the cost-aware routing net in `src/model-router.ts::selectModel`. Default ON. When ON, plain single-turn chat (`first_iteration`/`simple_chat`) is capped at Sonnet (never Opus) as a belt-and-suspenders guard even if the native binary is stale. The cheap-model down-routing for casual chat (GPT-5 nano/mini for the two lowest user-facing rungs; DeepSeek/GLM/GPT in background) lives in the native `select_dynamic_model` and needs `npm run build:native` — `ATLAS_NO_COST_ROUTING=true` only disables the TS Opus-cap net, not the native picks. User-facing tiers: `pn≤3 & score≤15`→gpt-5-nano, `pn≤4 & score≤25`→gpt-5-mini, else Haiku→Sonnet→Opus (Opus gated to ComplexChat/explicit-complexity branches). Cost tables kept in sync across `native/src/model_router.rs` registry, `src/llm-middleware.ts` MODEL_COSTS, and `convex/credit_cost.ts`.

**Codebase index:**
- `ATLAS_NO_CODEBASE_INDEX` — `codebase_index build` returns disabled
- `ATLAS_NO_ARCHITECTURE_INJECTION` — no first-iter `<architecture>` block
- `ATLAS_NO_REPO_MAP` — no first-iter `<repo_map>` block
- `ATLAS_INDEX_DEPTH=symbols|imports|calls` — override auto-picker
- `ATLAS_INDEX_ASYNC=force|never` — override block/async picker
- `ATLAS_CODE_PARSER=regex` — force legacy regex extractors
- `ATLAS_MULTI_TREE_SITTER=true` — opt-in Python/Rust/Go (crashes on 0.22 binding)
- `ATLAS_TS_DEBUG=true` — verbose tree-sitter loading
- `ATLAS_TOOL_DEBUG=off|verbose` — breadcrumb verbosity

**Proactive:**
- `ATLAS_PROACTIVE_DISABLE` — kill all proactive sends
- `ATLAS_PROACTIVE_DISABLE_SOURCES=csv` — silence sources (e.g. `heartbeat,goal`)
- `ATLAS_PROACTIVE_DISABLE_CHANNELS=csv` — silence channels
- `ATLAS_PROACTIVE_SHADOW` — compose + log but don't deliver
- `ATLAS_PROACTIVE_DEBUG=false` — suppress `🔔 [proactive]` logs

**Native ports (opt-IN unless noted):**
- `ATLAS_NATIVE_SPREADING` — opt-IN; SAN BFS via `native/spreading.rs`. FFI dominates at ≤150-node ceiling; enable only for >1000-node fan-out.
- `ATLAS_NO_NATIVE_SANITIZER` — disables native `sanitizeSecrets`/`containsSecrets`. Default native ON (1.44x-2.00x vs TS across 50B-100KB after `Cow<&str>` rewrite).
- `ATLAS_NATIVE_VAD` — opt-IN; live-voice barge-in via libfvad (`native/src/pcm_vad.rs`). Hybrid-mode only. Requires native built with `vad` cargo feature (`cd native && npx napi build --features vad --release`); default skips libfvad (30-60s build cost). Falls back to RMS transparently if feature missing.
- `ATLAS_VAD_MODE` — 0-3 aggressiveness (default 2)
- `ATLAS_NATIVE_AX` — opt-IN; AX tree flatten/find via `native/src/ax_walker.rs`. JSON round-trip dominates for <200 nodes; enable only for large AX trees.

**Skill Forge:**
- `ATLAS_NO_FORGE` — disables Forge entirely
- `ATLAS_NO_FORGE_LOOKUP` — disables lookup short-circuit
- `ATLAS_NO_FORGE_AUTO_SYNTHESIS` — disables auto-queue in `handleToolRequest`
- `ATLAS_NO_FORGE_VERIFIER` — disables P3 verifier; `synthesizeTool` short-circuits to stub-insert; `create_tool` skips forge route; end-of-turn hook becomes no-op
- `ATLAS_NO_SYNTHESIS_ESCALATION` — `maybeEscalateForSynthesis` becomes no-op
- `ATLAS_NO_SYNTHESIS_THINKING` — skip thinking bump on synthesis
- `ATLAS_FORGE_DREAM_OPUS` — Track B → Opus + max thinking (else Sonnet + high)
- `ATLAS_FORGE_STUB_LLM` — **TEST-ONLY**; skip LLM, insert stub row. Never in prod.

**Memory write-gate:**
- `ATLAS_NO_MEMORY_GATE=true` — disables the value-gate entirely; `remember()` reverts to direct-write behavior. Emergency rollback only.
- `ATLAS_MEMORY_GATE_SHADOW=true` (default during rollout) — gate decides and logs to `data/memory-gate.jsonl` but always inserts. Set to `"false"` explicitly to enable enforcing mode (rejected writes return `null`).

**Vision-nav:**
- `ATLAS_VISION_PROFILE=lite|standard|full` — override capability-detector pick (`src/screen/capability-detector.ts`)
- `ATLAS_NO_CLICK_MEMORY` — disables `src/screen/click-memory.ts`; rules out poisoned `data/click-memory.db`
- `ATLAS_NO_DRIFT_CALIBRATION` — disables `src/screen/drift-calibration.ts`; rules out bad affine fit
- `ATLAS_NO_CLOUD_GROUNDING` — disables the cloud grounding cascade tier (`src/screen/cloud-grounding.ts`). Default ON. The tier (qwen3.7-plus → qwen3-vl-235b fallback) fires on Lite/Standard + degraded-Full when local AX/OmniParser/UI-TARS miss. `os_smart_click` auto-captures a screenshot (window-scoped via `screencapture -R` when focused-window bounds known, else full-screen) so the vision tiers always have an image — without this the cascade was AX-only and silently skipped the vision tiers (root cause of low click accuracy). Window-scoped capture hands the cascade window-relative dims so `scaleImageToScreen` maps coords correctly.
- `ATLAS_NO_WINDOW_SCOPED_CAPTURE` — forces `os_smart_click` to full-screen capture instead of window-region capture (macOS). Diagnostic for coordinate-offset issues.
- `ATLAS_UI_TARS_AUTOPULL=true` — opt-IN; on a Full-tier box with Ollama but no UI-TARS model, background-pulls it at boot (`ensureUITarsForFullTier`). Default OFF (4.7GB pull). Pull is DETACHED (`src/screen/spawn-detached.ts`) so it survives the bot process exiting (a plain child got orphaned mid-pull). Without it, a degraded-Full box warns + uses cloud grounding.
- `ATLAS_OMNIPARSER_AUTOSETUP=true` — opt-IN; on Standard/Full, background-provisions the OmniParser venv + deps + icon_detect weights (`ensureOmniParser`, `src/screen/omniparser-setup.ts`, ~500MB, detached). Default OFF (warns with manual steps). The installer (`desktop/installer/phases.js` omniparserDeps) also now downloads weights as a soft sub-step. `omniParserWeightsPresent()` gates the cascade tier (skips spawning python when weights absent).
- `ATLAS_NO_OMNIPARSER=true` — force-skip the OmniParser cascade tier regardless of weights.
- `ATLAS_NO_AX_RETRY=true` — disables the cold-window AX re-dump retry in the cascade (`perception-router.ts`); `ATLAS_AX_RETRY_DELAY_MS` tunes the settle delay (default 250ms). The retry re-dumps the AX tree once after both AX tiers miss, since freshly-activated windows often have an incomplete tree on first dump.
- `ATLAS_NO_SMARTCLICK_VERIFY=true` — disables post-click verification of VISION-tier clicks (omniparser/ui_tars/cloud_grounding) in `os_smart_click`. Default ON: captures before/after, runs `classifyOutcome`; `no_op`/`wrong_target` → records a click-miss + returns `click_unverified` instead of a false success (AX/memory tiers stay trusted, no verify). Fixes the over-claim bug where dispatch-success was recorded as click-success unverified.
- `ATLAS_NO_SMARTCLICK_SELFCORRECT=true` — keeps verification but disables the one-shot self-correction (re-ground forcing descent past the failed tier) on a verified miss.
- `ATLAS_NO_UITARS_HEALTHCHECK=true` — skips the one-time vision-inference smoke test (`isUITarsHealthy`, `src/screen/ui-tars.ts`). A UI-TARS GGUF can be PULLED but crash at vision inference (broken/mismatched mmproj → GGML_ASSERT / Ollama 500); the health check (4×4 PNG probe, 30-min cached) detects this in ~3s so the cascade skips the broken model → cloud grounding, instead of eating a 30s crash/timeout per click. Bypass only when you've confirmed a model works and want to skip the probe.

### Rust expansion — empirical lessons (May 2026)

Original "more Rust = more speed" plan (`prancy-painting-reef.md`) didn't hold. Captured here so contributors don't re-run failed experiments.

**Rust wins (ship the port):**
- **Multi-pattern regex sweeps over KB-scale inputs.** Sanitizer fires 23 patterns over 1KB-100KB+ shell outputs. V8's regex engine can't deduplicate scanning across patterns; Rust sequential `regex::find_iter` + `Cow<&str>` zero-alloc-on-no-match wins 1.44×-2.00×. Pattern ordering is load-bearing for parity (sequential, NOT alternation); lookahead emulated with post-match prefix check (avoids `fancy-regex`).

**Rust loses (don't port):**
- **Hardware-accelerated Node.** `node:crypto` SHA-256 uses OpenSSL + SHA-NI/ARMv8-crypto. Rust `sha2` is software-only, 2-4× SLOWER. `blake3` ties at best on M-series. Codebase-merkle experiment confirmed — reverted.
- **Small per-call inputs over FFI.** napi-rs crossing costs ~500ns-3μs. For modules already at 1-15μs/call (json-extract, smart-truncate, smartChunkMessage, markdownToTelegramHtml), FFI tax is meaningful fraction. Wash or slower.
- **Graph BFS at small scales.** Spreading-activation BFS over ≤150-node graphs loses 5×-300×+ to TS — FFI dominates BFS work. Typed-napi was ~15% SLOWER than JSON (per-property marshalling > serde on small maps). `nativeSpreadActivationBfsTyped` retained as parity-tested but unused.
- **Already-fast file I/O + regex.** repo-map full scan of ATLAS (~1000 files) completes in 38ms in TS (OS cache + V8 JIT). Rayon Rust shaves ~25ms — not worth 587-line port.

**Rule:** Before porting, time TS on prod-representative input. Port only when (a) TS is genuinely slow (>>100μs/call AND hot path) AND (b) Rust has structural advantage (multi-pattern scanning Node can't share state across, or parallelism Node's single thread can't match). Otherwise FFI tax + maintenance = net negative.

**Caveat:** This is the perf rule. Correctness/safety wins (e.g. tree-sitter 0.22 multi-grammar bug) are separately justified.

**Rollout:** New native ports ship with opt-IN kill-switch (off day 1). After `scripts/bench-native.ts` shows measured win AND parity test passes byte-identical, flip default to ON (rename `ATLAS_NATIVE_X` → `ATLAS_NO_NATIVE_X`). Canonical example: sanitizer arc `c2fab4f` → `883a594`.

Every native module ships with per-case bench AND in-process parity vitest (`*.parity.test.ts`) running on every `npm test`. `bench-native.ts --parity-check` is the larger battery — run manually before flipping default.

## Key Patterns

- **ES Modules** throughout (`"type": "module"`, `NodeNext`)
- **Fail-open**: Native unavailable → JS fallback; memory crash → continue without persistence; tool missing → skip
- **Semantic over keyword**: Tool selection, query classification, memory recall all use embeddings + cosine
- **Parallelization with ordering**: Memory retrieval parallel; browser tools sequential, others parallel; boot I/O non-blocking where possible
- **Token budget injection**: Memory snippets capped (traits: 600 tokens, total: ~2-3K)
- **Cascade escalation**: Errors → upgrade model tier (works in sub-agents too)
- **Multi-layer caching**: LLM responses semantic-cached; tool results per-tool TTL (web_search 2min, read_file 1min, system_info 5min); memory queries via temporal cache + bloom filter
- **Graceful shutdown**: All subsystems have cleanup handlers
- **Dependency injection**: `LLMClient` created once at boot, passed in — never a singleton
- **OpenAI-compatible types**: All LLM uses `openai` types (`ChatCompletionMessageParam`, `ChatCompletionTool`) since Convex proxies via OpenRouter
- **Copyright headers**: All source files carry `© 2024-2026 XAGI Labs Private Limited`
- **Plan-mode state is a runtime gate**: `plan`/`spec`/`awaiting_approval` each have `*_ALLOWED_TOOLS` in `src/agents/plan-mode.ts`; `filterToolsFor*` strips BEFORE the LLM call; `checkWritePathInApprovalMode()` enforces at execution. New state: extend union type, add allowlist, add filter fn, wire into `isToolAllowedInCurrentMode`.
- **Structured debug logs**: coding tools emit `logToolAction()` from `src/utils/debug-log.ts`. Format: `🔧 [tool] ctx | path:line — action`. Silence with `ATLAS_TOOL_DEBUG=false`.

<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->
