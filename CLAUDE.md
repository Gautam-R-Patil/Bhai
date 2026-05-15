# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A.T.L.A.S (v0.2.0) is a continuously running, proactive personal AI agent built with Node.js/TypeScript (~385 .ts files) + a native Rust performance layer (~49 .rs files). It provides autonomous computer use, deep research, and long-running async workflows via Telegram, Discord, Slack, Matrix, WhatsApp, desktop overlay, and email channels.

## Build & Run Commands

```bash
npm run dev              # Development with tsx --watch
npm run build            # TypeScript → dist/ (also copies overlay.html via postbuild)
npm start                # Run production build (node dist/index.js)
npm run build:native     # Build Rust native module (cd native && npm install && npm run build)
npm run build:ocr        # Compile Swift OCR helper (macOS only, skipped elsewhere)
npm run build:location   # Compile Swift CoreLocation helper (macOS only; runs via predev hook before `npm run dev`)
npm run build:all        # Build native + OCR + location + TypeScript together
npm run lint             # Biome check (biome check .)
npm run typecheck        # Type-check without emitting (tsc --noEmit)
npm test                 # Run test suite (vitest run)
npm run test:watch       # Watch mode for tests (vitest)

# Convex backend
npx convex dev           # Start Convex dev server (watches convex/ for changes)
npx convex deploy        # Deploy Convex backend to production

# Desktop app (Electron 40+, electron-builder)
cd desktop && npm start           # Run locally
cd desktop && npm run build:mac   # Build macOS DMG (uses create-dmg.sh)
cd desktop && npm run build:win   # Build Windows NSIS installer
```

Requires Node.js >= 20. Testing via Vitest (`npm test`). No CI/CD pipeline. Linting via Biome (`npm run lint`). The build is just `tsc` + native Rust compilation.

## Architecture

### LLM Client (`src/llm.ts` + `src/crypto-transport.ts`)
All LLM calls are proxied through the Convex backend — the client never holds API keys. Flow:
1. `createLLMClient()` returns an `LLMClient` with a `.chat()` method
2. `.chat()` builds a message array with dynamic context (clock, widget hints) and sends it to `${convexSiteUrl}/api/llm/chat`
3. Transport uses ECDH P-256 key exchange + AES-256-GCM encryption (`encryptedFetch()`) on top of HTTPS
4. Server prepends its own system prompt (from `convex/systemContent.ts`) before forwarding to the LLM provider

Models are defined in `MODELS` constant (Opus, Sonnet, Haiku, GPT-5.x, Gemini). The `LLMClient` interface is injected into the agent, tools, swarm, and research subsystems.

Additional client-side layers injected in `.chat()`:
- **Semantic response cache** (`llm-cache.ts`) — Embedding-based similarity cache (cosine ≥ 0.88 for hit, 10min TTL, 200 entries LRU). Threshold was lowered from 0.95 to reduce false negatives on follow-ups; tune with care since tool-state is not part of the cache key yet. Only caches simple queries without tool calls or thinking mode.
- **Adaptive language matching** (`language.ts`) — Detects user language via Unicode script analysis + keyword heuristics, injects "Respond in {language}" instruction. Supports Devanagari, CJK, Cyrillic, Arabic, Hangul, Thai, and Latin-script languages (Spanish, French, German, etc.) including Romanized Hindi/Hinglish.

### Boot Sequence (`src/index.ts`)
Initialization is ordered and partially parallelized:
1. **Session + Auth**: `initSession()` creates Convex auth token, then `initAccountGuard()` verifies credits
2. **Memory**: SQLite databases, knowledge graph, traits, emotional state, episodic memory, self-state
3. **Async warmup (non-blocking)**: Embedding model warmup (`warmupEmbeddings()`), memory semantic migration (`embedExistingMemories()`) — failures are logged but non-fatal
4. **Tool infrastructure**: MCP servers, skills loader, browser memory, Docker sandbox, tool router (pre-computes category embeddings)
5. **Channels**: Canvas WebSocket, Google APIs, overlay chat, email (IMAP/SMTP), Telegram bot
6. **Scheduled tasks**: Heartbeat, memory decay (every 6h), dream replay (nightly at 3am)

### Agent Loop (`src/agent.ts:390` — `runAgent()`)
The core execution engine. Flow per invocation:
1. Account gate check (credits)
2. Message preprocessing + context pruning
3. **First iteration only**: Up to ~12 memory retrieval systems fire on iteration 1 (identity, traits, session summary, self-state, emotional context, episodic milestones, relationship tone, anticipation signals, core memory, query-specific recall, task learnings, knowledge graph entities). The three primary queries — semantic recall, conversation recall, task learnings — run in one `Promise.all`; others execute sequentially in and around it. Overall token budget ~2-3K tokens total injection.
4. **Each iteration**: `chooseModel()` via native Rust router → semantic tool selection → LLM call → tool execution → check for completion
5. **Tool execution**: Browser tools run sequentially (shared page state); all other tools run in parallel
6. **Cascade escalation**: If errors accumulate, auto-escalates model tier (Haiku → Sonnet → Opus)
7. Max 200 iterations; mid-session credit check every 5 tool calls

### Model Router (`src/model-router.ts` + `native/src/model_router.rs`)
Thin TypeScript wrapper around a native Rust binary (napi-rs). Decision factors: iteration count, error count, last tool calls, media presence, user hint ("simple"/"complex"). Three cost tiers:
- **Light** (0.25 credits): Haiku/Flash — casual chat, simple retrieval
- **Pro** (1 credit): Sonnet/GPT-5.3 — browser automation, tool calling
- **Heavy** (3 credits): Opus/GPT-5.4 — complex reasoning, deep research

Falls back to JS-only mode if native module fails to load.

### Tool Router (`src/tool-router.ts` + `src/tool-router-analytics.ts`)
Semantic tool selection using MiniLM embeddings (384-dim), not keyword matching:
- On boot: each tool category description is embedded and cached
- Per message: user query is embedded → cosine similarity finds top-K categories → loads those tool schemas
- A `request_tools` meta-tool lets the agent ask for additional tools mid-task
- 20+ categories: core, memory, browser, file_system, shell, system_control, media, integrations, etc.
- **FunctionGemma fallback** (`src/models/function-gemma.ts`): Optional local 270M model via Ollama for zero-cost tool routing
- **Analytics** (`tool-router-analytics.ts`): Tracks tool usage patterns, selection accuracy, category hit rates

### Memory System (`src/memory/` — 39 files)
All local SQLite (`data/memory.db`). Key subsystems:
- `sqlite.ts` — Primary store: `remember()`, `recall()`, `getCoreMemory()`
- `knowledge-graph.ts` — Entity-relationship graph (people, tools, preferences)
- `vector-index.ts` — HNSW approximate nearest neighbor for semantic recall
- `reflection.ts` — Nightly dream replay consolidates learnings; decay runs every 6h
- `task-learnings.ts` — Persists strategies for recurring task types
- `identity.ts`, `traits.ts`, `emotional.ts`, `episodic.ts`, `self-state.ts`, `session.ts`, `relationship.ts` — Specialized memory tiers
- `working-memory.ts`, `hopfield-memory.ts` — Short-term and associative recall
- `world-model.ts`, `user-model.ts` — World/user state models; `active-inference.ts`, `counterfactual.ts`, `prospective.ts` — Predictive reasoning
- `sleep-gate.ts`, `surprise-gate.ts` — Consolidation gating; `reranker.ts`, `strategy-library.ts` — Retrieval reranking + strategy patterns
- `classifier.ts`, `context-pruning.ts` — Query classification and context window management
- `goals.ts`, `self-evolving.ts`, `self-model.ts`, `memory-informed-planning.ts` — Goal tracking, self-model, memory-driven planning
- `consolidation.ts`, `multimodal.ts`, `temporal-cache.ts`, `embeddings.ts`, `multimodal-embedding.ts` — Consolidation, multimodal storage, bloom-filter cache, embedding generation

### Channel Flow (Telegram example: `src/telegram.ts`)
```
Telegram message → User ID whitelist check → Media extraction (voice/image/video)
→ runAgent(llm, message, onProgress, media) → Streaming response
→ smartChunkMessage() (sentence-boundary splitting) → Markdown→HTML conversion → Send
```
Internal tags (`<system_log>`, `<tool_log>`) are stripped before sending to user.

### Convex Backend (`convex/`)
Acts as API key proxy, auth layer, and store backend — LLM API keys never reach the client:
- `http.ts` — HTTP actions that proxy LLM calls server-side with E2E encryption
- `sessions.ts` — Session token management (create, refresh, revoke); 24h TTL with ECDH shared key for E2E encryption
- `accounts.ts` — Credit tracking with atomic server-side deduction; plans: free/pro/enterprise
- `crypto.ts` — Server-side ECDH + AES-256-GCM encryption utilities
- `systemContent.ts` — Server-side system prompt assembly (prompts never sent to client)
- `schema.ts` — Database schema: `accounts`, `sessions`, plus full store marketplace tables (`developers`, `admins`, `store_items`, `submissions`, `store_installs`, `store_reviews`, `store_activity_log`) and system content tables (`system_prompts`, `system_skills`)
- `convex/store/` — Store CRUD operations: `items.ts`, `submissions.ts`, `developers.ts`, `storage.ts`, `admins.ts`, `installs.ts`, `reviews.ts`

### Native Rust Layer (`native/src/` — 49 .rs files)
SIMD-accelerated vector operations (~15-20x speedup) via napi-rs. Built with `opt-level=3`, LTO, `panic=abort`, stripped binaries. Key dependencies: `wide` (SIMD), `simsimd` (similarity), `rayon` (parallelism), `aes-gcm` (encryption). Modules mirror their TS counterparts in `src/` (routing, memory, orchestration, reasoning, predictive, proactive); `lib.rs` is the napi-rs entry, `chrome_bridge.rs` is the extension bridge. Run `ls native/src/` for the full inventory.

### Agent Orchestration (`src/agents/` — 30 files)
Four-tier execution model for tasks of increasing complexity, with extensive reliability, optimization, and self-improvement layers:

**Core Execution Tiers:**
- **Sub-Agent** (`sub-agent.ts`) — Specialized roles (researcher, coder, browser, system, general); scoped tools, loop detection, error-driven escalation, `request_tools` dynamic expansion, priority-based timeout/model scaling, partial result streaming, per-iteration cost tracking
- **Swarm** (`swarm.ts`) — Decomposes tasks into sub-agent steps (max 20), executes via Mesh, synthesizes with evaluator-optimizer loop + replanning, integrates task learnings. Triggered by `swarm_task` tool
- **Mesh** (`mesh.ts`) — Parallel DAG executor: critical path scheduling, layered recovery (retry→rephrase→reroute→skip), structured handoff messages, dynamic role assignment
- **Long-Task** (`long-task.ts`) — Multi-phase executor: 200 iterations/phase, 30 min timeout, max 100 phases. Checkpoints to `data/long-tasks/${taskId}.json` every 60s; inter-phase replanning (max 3 replans)

**Reliability Layers** (`src/agents/`):
- `error-recovery.ts` — retry (exponential backoff) → rephrase → reroute (switch role) → skip
- `error-types.ts` — `ErrorCategory` enum (Transient, Permanent, ResourceLimit, ToolMissing, ParseError, Timeout, UserCaused)
- `smart-truncate.ts` — Tool-specific truncation: shell (tail-heavy), JSON (parse+prune), browser (keep IDs), files (head+tail)
- `handoff.ts` — Structured inter-agent context: 300-char summary, 5 key findings, artifact refs, errors

**Optimization Layers** (`src/agents/`):
- `evaluator.ts` — Quality scoring (completeness/accuracy/coherence/actionability 0-100) with retry-on-low-score
- `replanner.ts` — Revises remaining plan when failures or new information detected mid-execution
- `role-analyzer.ts` — Keyword-based role classifier, overrides LLM roles when confidence > 0.7
- `mixture.ts` — Mixture of Agents: parallel proposals + aggregation for complex tasks (≥5 steps)
- `speculative.ts` — Races primary + alternative approaches, first success wins
- `decomposition-library.ts` — Saves/reuses successful decomposition templates (`data/decomposition-templates.json`)
- `blackboard.ts` — Per-swarm shared context; `complexity-classifier.ts` — injects swarm/long-task hints

**Self-Improvement & Specialized Agents** (`src/agents/`):
- `metacognition.ts`, `multi-critic.ts` — Self-monitoring and multi-perspective output evaluation
- `code-critic.ts` — compile_check + test_runner + lint_style + SAST (Semgrep) + ui_verify, fires in `swarm.ts:~215` for coder steps. Weights 0.4/0.4/0.2/0.15. Budgeted via `ATLAS_POST_SYNTHESIS_BUDGET_MS` (default 90s)
- `agent-worktree.ts` — Git worktree isolation for parallel coders (opt-in `ATLAS_AGENT_WORKTREE=true`). Allocates `data/agent-worktrees/<id>/` per coder step when ≥2 would race; rewrites file-tool paths into the worktree root
- `textgrad-refiner.ts`, `self-editor.ts`, `self-heal.ts` — Iterative refinement, self-editing, failure recovery
- `code-action-agent.ts`, `computer-use-agent.ts` — Specialized code-gen and GUI automation agents

### Coding Agent Pipeline (`src/tools/coding/` — 25+ files)
ATLAS's coding surface is more than a bag of edit/write tools — there's a staged pipeline with runtime gating. Understand this before touching anything in `src/tools/coding/` or `src/agents/plan-mode.ts`:

**Complexity classification (`src/model-router.ts::classifyCodingComplexity`)**:
On the first iteration of any coding task, a regex-based classifier returns `"trivial" | "standard" | "complex"` and `src/agent.ts` injects a `<coding_complexity>` system reminder telling the agent which playbook to follow. Trivial (add-log, typo, rename, bump-version) skips Pro tier and the docs ceremony. Standard implements directly on Pro tier. Complex (refactor / new-system / build-verb + high-stakes-domain / >400 chars) fires the full design-docs flow.

**Pro-tier routing (`src/model-router.ts::maybeEscalateForCoding`)**:
Any non-trivial coding intent forces tier ≤ 4 (Sonnet / Opus / Gemini Pro / Nova Pro). Tier numbers are inverted from intuition: 0=Opus (top), 2=Sonnet, 3=Gemini Pro, 4=Nova Pro, 5=Haiku, 6-9=lighter. `PRO_TIER_CEILING = 4`. `selectForSubAgent(..., role)` pins coder sub-agents to Pro independently. Extended thinking budget (`response.reasoning`) also lifts for complex coding unless `ATLAS_NO_CODING_THINKING=true`.

**Complex-task flow — four phases**:
1. **Design docs** — `generate_design_docs({ task })` writes PRD.md + TECHNICAL.md + ARCHITECTURE.md under `A.T.L.A.S Files/Documents/design-docs/<slug>/`. Uses an in-tool Sonnet LLM call with `responseFormat: "json_object"` to fill the bodies; falls back to hand-scaffolded templates on LLM failure. **Auto-transitions plan-mode to `awaiting_approval` state on success** — implementation tools are runtime-blocked until the user approves.
2. **Approval gate** — `awaiting_approval` is a fourth plan-mode state alongside `act`/`plan`/`spec`. Tool allowlist (`AWAITING_APPROVAL_ALLOWED_TOOLS`): reads, `edit`/`write` restricted to the design-docs dir via `checkWritePathInApprovalMode()`, channel senders, `render_md_to_pdf`, `approve_design_docs`, `generate_design_docs` (for regen). `shell_exec`/`test_run`/arbitrary-file `edit` refuse at the tool layer. User approval → agent calls `approve_design_docs({ user_quote: "<user's own words>" })` (quote field is required for audit) → transition to `act` mode.
3. **Implement** — standard coder loop on Pro tier. Worktree isolation if `ATLAS_AGENT_WORKTREE=true` AND ≥2 parallel coder steps.
4. **Walkthrough** — `demo_project({ project_dir })` auto-detects stack and launches the runtime. Agent calls `browser_verify` / `os_screenshot` / `screen_record`, then `generate_walkthrough()` reads `git log` + `git diff` to produce WALKTHROUGH.md. Delivery: overlay (inline MD + screenshot), TG/WA (`render_md_to_pdf` + screenshot/MP4), Discord/Slack (attach MD).

**Write-path gating rule** (runtime, not just prompt): `src/tools/coding/edit.ts` and `write.ts` both call `checkWritePathInApprovalMode(filePath)` before writing. In `awaiting_approval`, only paths under the active `designDocsDir` pass.

**Debug logs** — every tool call in a coder sub-agent emits a structured breadcrumb via `src/utils/debug-log.ts::logToolAction({ tool, filePath, line, action, context })`. Format: `🔧 [tool] sub_agent=id role=r | path:line — action`. The outer ATLAS process logger prepends ISO timestamps. Silenced with `ATLAS_TOOL_DEBUG=false`.

### Codebase Comprehension (Phase 4L — `src/memory/codebase-*` + `src/tools/coding/codebase-*`)
A per-repo SQLite sidecar that understands the working repo's structure. Distinct from `memories.db` — lives under `data/codebase-index/<repo-hash>.db`, auto-built on first coding iteration for the current `process.cwd()`.

- **`src/memory/codebase-sidecar.ts`** — Opens/caches the sidecar (schema `4L.3`). Tables: `files`, `symbols`, `imports`, `calls`, `parse_errors`, `index_meta` + `symbols_fts` FTS5 table for BM25 search.
- **`src/memory/codebase-merkle.ts`** — SHA-256 hashing + repo-root resolution. Incremental refresh skips unchanged files.
- **`src/memory/code-parse/`** — Language-dispatching parser. `tree-sitter-extractors.ts` is the default for TypeScript + JavaScript (tree-sitter core 0.22.4 + tree-sitter-typescript 0.23.2); `regex-extractors.ts` is the fallback covering 15 languages. Python / Rust / Go tree-sitter grammars are installed but gated behind `ATLAS_MULTI_TREE_SITTER=true` because the 0.22 native binding has a multi-grammar node-subclass collision bug. Flip the flag when upstream ships a fix. `ATLAS_CODE_PARSER=regex` forces the legacy path globally. Max file size bumped to 500 KB (was 100 KB — agent.ts is 129 KB).
- **`src/memory/codebase-index.ts`** — `buildIndex` / `refreshIndex` / `getIndexStats` / `wipeIndex`. Depth tier via `pickDepth()`: ≤500 files → `calls` (full graph), ≤5000 → `imports`, else → `symbols`. `ATLAS_INDEX_DEPTH` overrides. `ensureIndexForCoding(root)` is called on first coding iteration; block vs async decided by `pickTiming()` (≤100 files → block). `getArchitectureSnippet(root)` returns a Mermaid + ASCII summary injected into the prompt.
- **`codebase_query` ops** (`src/tools/coding/codebase-query.ts`): `find_symbol`, `find_usages`, `search` (BM25 FTS5 — e.g. "authenticate user" finds `isEmailAuthenticated`), `ego_graph` (k-hop BFS call-graph from a file:line), `file_neighborhood`, `describe_file`, `architecture_overview`, `dependency_chain`.
- **`codebase_index` commands**: `build` / `refresh` / `stats` / `wipe`. Runs transactions via the raw better-sqlite3 handle (`getRawSidecar()`), not the wrapped helper — the wrapped one routes to `memories.db`.
- **`src/memory/self-evolving.ts`** — Nightly synaptic prune explicitly skips `category = 'code'` AND `category NOT LIKE 'code\\_%'` so the coding-strategies written by `reflection.ts::extractCodingStrategies` aren't aged-out. If you add a new coding-memory category, add it here too.

Related read-side tools: `code_change_summary` (read-only git: `recent_commits`/`hot_files`/`diff`/`blame`), `agents_md_scaffold` (generates AGENTS.md + 8 sub-docs with `<!-- @atlas:auto -->` machine-owned markers), `lsp` with `getDiagnostics` operation that consumes `textDocument/publishDiagnostics` notifications — auto-attached to edit tool results as `post_edit_diagnostics` when the file is a code extension, unless `ATLAS_NO_POST_EDIT_DIAGNOSTICS=true`.

Write-side: `git_op` with 4-tier safety model (safe/confirm/destructive/blocked). Protected branches `main`/`master`/`production`/`release/*` + evidence-phrase gate for `push --force` AND `push --force-with-lease`. Ephemeral `checkpoint`/`restore_checkpoint` via `git stash create` (returns SHA without pushing to stash list).

### Workspace & Artifact Outputs (`src/config/paths.ts`)
All user-facing artifacts land under a single workspace root resolved by `getWorkspaceDir()`:
- Primary: `$ATLAS_WORKSPACE` (set by the desktop installer)
- Fallbacks (first existing): `~/Desktop/A.T.L.A.S Files` → `~/Documents/A.T.L.A.S Files` → `~/.atlas/files`
- Created on demand: `~/A.T.L.A.S Files`
- Last resort: `os.tmpdir()`

Subdirectory accessors create on-demand:
- `getCodeDir()` → `<workspace>/Code` — **default for `scaffold_project`** (was `process.cwd()`)
- `getDocumentsDir()` → `<workspace>/Documents` — `design-docs/<slug>/` + `walkthroughs/<slug>/` live here
- `getImagesDir()`, `getScreenshotsDir()`, `getDownloadsDir()`, `getTempDir()`

The rule: any tool that writes a user-facing artifact should default to a `getWorkspaceSubdir()` path and accept an explicit override only when the user named one. Anything under `data/` is for ATLAS-internal state (SQLite, checkpoints, browser profile, agent worktrees).

### Browser Tools (`src/tools/browser/` — 15 files; `src/tools/` has ~45 top-level tool files, ~60 total)
Dual-backend browser automation. The `BrowserBackend` interface (`browser-backend.ts`) abstracts over two engines:
- **Playwright** (`playwright-backend.ts`) — Headless Chromium for automated browsing, persistent profile in `data/browser-profile/`
- **Chrome Extension** (`chrome-backend.ts` + `chrome-bridge.ts`) — WebSocket bridge to user's real Chrome browser via companion extension, no headless browser needed; `ChromePageProxy` class mimics Playwright's Page API surface
- `stagehand-bridge.ts` — AI-native browser framework integration
- `mode-tools.ts` — Switches agent between fast (DOM-only) and vision (screenshot + OCR) modes
- `profile-sync.ts` — Browser profile synchronization
- 25+ browser actions exposed: navigate, click, type, scroll, extract, parallel tabs/actions, upload, JS execution, strategy save/recall

### Tool Intelligence (`src/tools/tool-intelligence.ts` + `create-tool.ts`)
- **Tool intelligence** — Per-tool caching (TTL-based: web_search 2min, read_file 1min, system_info 5min), rate limiting, audit logging, confirmation gates
- **Dynamic tools** (`create-tool.ts`) — Agent-created tools that persist to `~/.atlas/store/tools` and hot-reload at runtime. Generated handlers run inside a `vm.createContext` sandbox with a restricted require shim.

### Skill Forge (`src/forge/` — Phases 1+2 shipped)
ATLAS-specific dynamic-tool reliability layer. Phase 1: foundation (SQLite library, manifest, hot-reload). Phase 2: lookup-first short-circuit so `create_tool` reuses existing tools before synthesizing. Kill switches: `ATLAS_NO_FORGE`, `ATLAS_NO_FORGE_LOOKUP`, `ATLAS_NO_FORGE_AUTO_SYNTHESIS`.

Lookup pipeline: FunctionGemma 270M (zero cost when Ollama+model present) → FTS5 BM25 over description+schema_keys → cosine rerank against embeddings (threshold 0.85). Dedup at write time at 0.85 / 0.92 thresholds (warn vs merge).

Public API at `src/forge/orchestrator.ts`:
- `initForge({ embedFn })` / `isForgeReady()` / `getForgeStats()` — boot + introspection
- `lookupTool(description, schema)` — Phase 2 lookup, returns `ToolMetadata | null`
- `queueSynthesisCandidate(req)` / `consumeNextPendingCandidate()` — Phase 2 auto-synthesis queue
- `synthesizeTool`, `approveDynamicTool`, `runDreamReplaySynthesis` — Phase 3+ stubs

Spec: `docs/superpowers/specs/2026-05-15-forge-tool-creation-overhaul-design.md`. Deep dives in `docs/superpowers/specs/forge-deep-dives/`.

### Deep Research (`src/research/` — 11 files)
Background research engine with its own execution loop:
- `executor.ts` — Research loop (up to 500 sources); `engines.ts` — search provider abstraction; `fetcher.ts` — HTML→text; `scoring.ts` — relevance scoring; `persistence.ts` — saves to `data/research/`
- `hypothesis-engine.ts` — hypothesis generation + testing; `credibility-model.ts` — source credibility; `analysis.ts` — deep analysis; `profiles.ts` — research profiles

### Runtime Data (`data/`)
All runtime artifacts live in the `data/` directory (gitignored). Distinguish between internal state here and USER-facing outputs under `A.T.L.A.S Files/…` (see Workspace & Artifact Outputs above).
- `data/memories.db` — SQLite database for all memory subsystems
- `data/codebase-index/<repo-hash>.db` — Per-repo sidecar indexes (Phase 4L)
- `data/agent-worktrees/<step-id>/` — Throwaway git worktrees for parallel coders (Phase 4G; only allocated when `ATLAS_AGENT_WORKTREE=true`)
- `data/long-tasks/` — Checkpoint JSON files for resumable long tasks
- `data/research/` — Saved research results (markdown)
- `data/browser-profile/` — Persistent Playwright browser profile (cookies, cache)
- `data/google-credentials.json` + `data/google-tokens/` — Google API OAuth tokens
- `data/proactive-config.json` — Per-channel posture (calm/active/ambient), urgentAllowedAfter time, night windows. Reloaded at runtime without restart.

### Social Cognition (`src/social/` — 1 file)
- `emotion-detector.ts` — zero-cost heuristic (lexicon + punctuation) returning `{ primary, valence, arousal, signals }`. `src/prompts/dynamic-context.ts::buildDynamicContextReminder` bridges this into `assembleDynamicPrompt`'s `userEmotionalState` slot, and `src/agent.ts` injects the assembled block on the first iteration. Removed stubs (`theory-of-mind`, `pragmatics`, `persuasion`) lived in this directory historically but were LLM-heavy or speculative; the LLM handles their concerns natively now.

### Planning & Execution (`src/planning/` + `src/execution/`)
- `mcts-planner.ts` — Monte Carlo Tree Search (UCB1, scored by Process Reward Model); `hierarchical-planner.ts` — multi-level decomposition
- `process-reward.ts` — step-level reward model; `logic-verifier.ts` — plan consistency verification; `pattern-speculator.ts` — speculative execution

### Local Models (`src/models/` — 5 files)
On-device model integrations (zero API cost):
- `function-gemma.ts` — 270M CPU model via Ollama for tool routing (85% accuracy, falls back to LLM if unavailable)
- `local-asr.ts`, `local-tts.ts` — Local speech recognition and synthesis
- `local-ocr.ts` — Local OCR processing
- `local-vision.ts` — Local vision model for image understanding

### Dynamic Prompts (`src/prompts/` — 3 files)
- `dynamic-assembler.ts` — Context-aware system prompt assembly (replaces static concatenation). Composes optimal prompt based on task type, user emotional state, relationship depth, hour-of-day
- `prompt-evolver.ts` — Iterative prompt refinement
- `watermark.ts` — Response watermarking

### Alive UX (`src/alive-ux.ts`) + Network Health (`src/network-health.ts`) + Location (`src/location/`)
- **Alive UX** — Centralized personality/phrasing system; prevents phrase repetition, adapts tone to time-of-day/mood/task
- **Network Health** — Tracks online/degraded/offline; subsystems call `isOnline()` before network calls. 45s passive / 15s recovery checks
- **Location** (`src/location/` — 7 files) — Singleton location service: GPS → Wi-Fi → IP fallback via pluggable providers. `network-watcher.ts` drives refresh; Swift helper invoked by GPS provider on macOS

### Widget (`src/widget/widget.ts`)
Self-contained embeddable chat widget served as `/widget.js` from the overlay server. A single IIFE injects its own DOM + styles + WebSocket logic, authenticates via `?token=` query param, and connects to the overlay WebSocket to give any webpage a floating chat bubble.

### Additional Subsystems
- **MCP** (`src/mcp/`) — Model Context Protocol server integration (`client.ts`, `gitmcp-bridge.ts` exposed as the `gitmcp_docs` tool via `src/tools/gitmcp.ts`); loads external tool providers at boot
- **Proactive** (`src/proactive/` — 28 files) — Heartbeat engine, proactive behaviors, automated night dreaming. Phase 0+1 additions: `intent.ts`/`intent-from-thought.ts` (ProactiveIntent types + thought→intent bridge), `composer.ts`/`composer-templates.ts` (template fast-path → LLM fallback → banned-phrase + third-person post-filters), `dispatch.ts` (single exit point — kill-switch gates, mode emoji 💡/❓/✅ prefix), `config.ts` (per-channel posture: calm/active/ambient; night-window config via `data/proactive-config.json`), `kill-switches.ts` (env-var gate fns). Also: `goal-engine.ts`, `habit-detector.ts`, `inner-thoughts.ts`, `thought-journal.ts`, `trigger-detector.ts`, `notification-tracker.ts`, `environment-sensors.ts`, `proactive-reward.ts`, `dnd.ts`, `monitors.ts`, `activity.ts`, `recommendations.ts`
- **Security** (`src/security/`) — Sandboxing (`sandbox.ts`), input validation (`allowlist.ts`), outbound secrets scrubber (`secrets-sanitizer.ts` — scans tool results for API keys before returning them to the LLM), audit log (`audit-log.ts`), Docker isolation logic
- **Voice** (`src/voice/`) — Voice message processing (`telegram-voice.ts`), transcription (`transcribe.ts`), TTS via `tts.ts` (provider selection: `ATLAS_TTS_PROVIDER` → `ELEVENLABS_API_KEY` → `OPENAI_API_KEY`), continuous live voice mode (`live/`)
- **Canvas** (`src/canvas/`) — WebSocket-based canvas channel for rich UI interactions
- **Commands** (`src/commands/`) — Slash-command parsing for Telegram/overlay input
- **Skills Loader** (`src/skills/`) — Loads skill files (gray-matter frontmatter markdown from `skills/` and `~/.atlas/store/skills`) into agent context based on task type
- **Store** (`src/store/`) — Marketplace functionality: `client.ts` (Convex-auth'd proxy), `installer.ts` (download + extract + hot-reload, cross-platform archive handling via `Expand-Archive` on Windows + `tar` elsewhere), `sideload.ts` (agent-facing `sideload_skill` tool for local files), `hot-reload.ts`. Read-only agent access via `store_browse` tool (`src/tools/store-browse.ts`) with ops: search, list, info, featured, trending, categories, installed. Install/uninstall stay in the desktop UI (need a consent gate).
- **Additional Channels** — Discord (`src/discord.ts`), Slack (`src/slack.ts`), Matrix (`src/matrix.ts`)
- **Config** (`src/config/`) — Centralized config: API keys (`keys.ts`), filesystem paths (`paths.ts`)
- **Notifications** (`src/notifications/`) — Push notification delivery (`push.ts`)
- **LLM Middleware** (`src/llm-middleware.ts`) — Middleware layer between LLM client and agent
- **Types / Utils** (`src/types/`, `src/utils/`) — Ambient type declarations (`qrcode-terminal.d.ts`, `sql.js.d.ts`) and shared utilities (`json-extract.ts` for robust LLM JSON parsing, `system-resources.ts`, `uuid.ts`)

### WhatsApp Channel (`src/whatsapp.ts` + `src/whatsapp-users.ts`)
WhatsApp is the most privilege-differentiated channel. It uses Baileys (`@whiskeysockets/baileys`) and splits every inbound message into one of four flows based on sender identity. State lives in `data/whatsapp-users/` (owners, contacts, personas, groups as JSON files) — **not** in `data/memories.db`.

**Identity tiers** (resolved per message in `whatsapp-users.ts`):
- **Owner** — JID in `owners.json`; full tool access, `isOwner: true`. Conversation history in-memory (not persisted).
- **Allowed contact** — Owner-approved JID; persona-gated access.
- **Unknown contact** — notifies owner on first message; `autoAllow` flag promotes after delay.
- **Group** — JID `*@g.us`; separate flow (see Groups below).

**Persona system** (`whatsapp-users.ts`): Single global persona in `whatsapp-persona.json` (name, system prompt, `allowedToolNames[]`). Applied to all non-owner messages. `whatsapp.ts:~933` hard-codes anti-impersonation rules (reject "I am the owner" claims, refuse system actions on owner's behalf) — these are in code, not persona config. Do not weaken them.

**Groups** (`WhatsAppGroup` in `whatsapp-users.ts`, handlers in `whatsapp.ts`):
- **Add flow** (`groups.upsert`, `whatsapp.ts:1499`): owner in participants → auto-approve (`active`); otherwise → `pending`, DMs owner with `approve`/`decline` prompts. Non-owner-added groups are silent until approved.
- **Status lifecycle**: `pending` → `active` → optionally `muted`. Admin commands: `approve X`, `decline X`, `groups`, `mute/unmute group X`.
- **Response gating** (`handleGroupMessage`, `whatsapp.ts:1033`): group must be `active`; always respond if directly @mentioned or replied-to; otherwise throttle: skip if <30s since last send or bot share >15% of total messages; then Haiku YES/NO chime-in decision (failure = silent).
- **Tool allowlist**: `senderIsOwner ? undefined : getPersona().allowedToolNames` — owners get full tools even in groups; all other participants are persona-restricted.

### Web Portals (`portals/`)
Both are Next.js + Tailwind CSS apps with their own `package.json` and `.env.example`:
- `portals/admin-panel/` — Admin dashboard for managing users, store submissions, system prompts/skills
- `portals/developer-portal/` — Developer-facing portal for skill/tool/MCP server publishing

### Overlay App (`overlay-app/`)
Native macOS Swift app (`Package.swift`) for the desktop overlay UI (distinct from the inline `src/overlay/overlay.html`).

### Chrome Extension (`chrome-extension/`)
User-side companion for `src/tools/browser/chrome-backend.ts`. `background.js` bridges WebSocket to agent, `content.js` provides DOM access, `popup.html`/`popup.js` provides the toggle. Lets the agent drive the user's real Chrome instead of headless.

### Admin Dashboard / Scripts / Docs
- `admin-dashboard/index.html` — Single-file static dashboard (separate from the full Next.js `portals/admin-panel/`)
- `scripts/` — Swift helpers (`get_location.swift`, `ocr_screen.swift`), vision overlays (`grid_overlay.py`, `som_overlay.py`), OS hotkeys (`atlas-hotkey.ahk/lua`), Convex seeds (`seed-store.ts`, `seed-system-content.ts`), `patch-baileys.sh` (postinstall)
- `docs/` — Internal documentation (e.g. `docs/superpowers/`)

### Configuration
- Environment variables via `.env` (see `.env.example`)
- Required: `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`, `ATLAS_OTPLESS_USER_ID`
- Optional: `EMAIL_USER`/`EMAIL_PASSWORD`, `EMAIL_WHITELIST`, `GITHUB_TOKEN`, `HF_TOKEN` (for gated embedding models), `MEMORY_DEBUG`
- Optional voice: `LIVE_VOICE_NAME` (Gemini: Aoede/Charon/Kore/Fenrir/Puck; OpenAI: alloy/shimmer/echo), `LIVE_VOICE_BACKEND` (gemini-live/openai-realtime/hybrid)
- `ATLAS_ENV=prod` — flip Convex client from dev (`zany-kudu-607`) to prod (`avid-oyster-465`); default stays on dev. Individual override via `CONVEX_URL` / `CONVEX_SITE_URL`.
- OpenRouter and Convex keys are bundled — not user-configurable

**System prompts are SERVER-SIDE**:
Prompts live in Convex `system_prompts` table, seeded from `prompts/` via `scripts/seed-system-content.ts` (needs `ADMIN_API_KEY`). The client never reads them from disk — `src/config/system-prompts.ts::fetchSystemPrompt(slug)` pulls on demand via `/api/system/prompt?slug=` with in-flight request coalescing + single-flight auth refresh. Desktop electron-builder deliberately does NOT bundle `../prompts`. The `prompts/` dir in the repo is source-of-truth for what the seed script uploads.

Seeded slugs: `identity`, `rules`, `rules-mac`, `rules-windows`, `browsing`, `thinking`, `coding` (Phase 4 tool-use workflow), `spec` (spec-mode guidance).

- Skills loaded from `skills/` (built-in — 12 role markdown files plus 5 Convex-specific skill directories: `convex-create-component`, `convex-migration-helper`, `convex-performance-audit`, `convex-quickstart`, `convex-setup-auth`) and `~/.atlas/store/skills` (user-installed); each role skill is a markdown file with gray-matter frontmatter defining role, triggers, and instructions. Skills are likewise server-side via `system_skills` table.

### Env Kill-Switches (fail-open knobs for new subsystems)
Most entries default to the feature ON; set to `"true"` (or the named sentinel) to disable. A few are explicitly opt-IN — those are noted inline (look for "opt-IN" in the description). Use `grep -rnE "process\.env\.ATLAS_" src/` to find the call sites before altering behavior.

- `ATLAS_NO_CODING_ESCALATION` — disables `maybeEscalateForCoding` (coding tasks stay on whatever tier the base router picked)
- `ATLAS_NO_CODING_THINKING` — disables extended thinking budget on Pro-escalated coding
- `ATLAS_NO_CODER_SPECULATION` — disables racing alt approaches on coder steps inside `shouldSpeculate`
- `ATLAS_WAVE_SPECULATION_CAP` — int (default `1`) or `"off"` — per-wave cap on concurrent speculative executions
- `ATLAS_AGENT_WORKTREE` — opt-IN (off by default); enables git worktree isolation for parallel coder steps
- `ATLAS_NO_AGENT_WORKTREE` — force-off even if above is set
- `ATLAS_DISABLE_BUILTIN_HOOKS` — drops the built-in LSP-pre-edit PreToolUse hook
- `ATLAS_NO_CODE_CRITIC` — skips the compile/test/lint/SAST critic in swarm synthesis
- `ATLAS_NO_POST_EDIT_DIAGNOSTICS` — edit tool doesn't auto-attach LSP diagnostics to its result
- `ATLAS_NO_SAST` — Semgrep perspective skipped inside `code-critic`
- `ATLAS_NO_CODEBASE_INDEX` — `codebase_index build` returns `{ success: false, error: "disabled" }`
- `ATLAS_NO_ARCHITECTURE_INJECTION` — first-iteration `<architecture>` block not injected
- `ATLAS_NO_REPO_MAP` — first-iteration `<repo_map>` block not injected
- `ATLAS_INDEX_DEPTH=symbols|imports|calls` — override the auto-picker
- `ATLAS_INDEX_ASYNC=force|never` — override the block/async timing picker
- `ATLAS_CODE_PARSER=regex` — force the legacy regex extractors even where tree-sitter would work
- `ATLAS_MULTI_TREE_SITTER=true` — opt-in for Python/Rust/Go tree-sitter (known to crash on 0.22 binding)
- `ATLAS_TOOL_DEBUG=off|verbose` — debug-log verbosity for tool-call breadcrumbs
- `ATLAS_POST_SYNTHESIS_BUDGET_MS` — wall-clock cap on code-critic + multi-critic + MoA chain (default 90000)
- `ATLAS_AUTO_PLAN_MODE` — opt-in auto-entry into plan mode on first user message
- `ATLAS_TS_DEBUG=true` — verbose tree-sitter grammar-load logging
- `ATLAS_PROACTIVE_DISABLE` — kill all proactive sends globally
- `ATLAS_PROACTIVE_DISABLE_SOURCES=csv` — silence specific intent sources (e.g. `heartbeat,goal`)
- `ATLAS_PROACTIVE_DISABLE_CHANNELS=csv` — silence specific channels (e.g. `telegram,whatsapp`)
- `ATLAS_PROACTIVE_SHADOW` — shadow mode: compose + log proactive messages but never deliver
- `ATLAS_PROACTIVE_DEBUG=false` — suppress `🔔 [proactive]` debug logs (on by default)
- `ATLAS_NATIVE_SPREADING` — opt-IN (off by default); routes SAN BFS through `native/spreading.rs`. Bench shows FFI dominates BFS at the ≤150-node production ceiling — both JSON and typed-napi variants tested and lost (see Rust-expansion section below). Enable only with workloads that have large recall fan-out (>1000-node induced graphs).
- `ATLAS_NO_NATIVE_SANITIZER` — disables the native `sanitizeSecrets`/`containsSecrets` impl in `native/secrets_sanitizer.rs`. Default is native ON — bench (`scripts/bench-native.ts`) shows native at 1.44x–2.00x of TS across 50B–100KB inputs after the sequential-per-pattern `Cow<&str>` rewrite (zero allocation on no-match passes). Force TS fallback for debugging or when the native binary is unavailable.
- `ATLAS_NATIVE_VAD` — opt-IN (off by default); routes live-voice barge-in detection through libfvad (`native/src/pcm_vad.rs`) instead of the RMS-amplitude gate. **Hybrid-mode only** — native Gemini Live / OpenAI Realtime backends use server-side VAD and ignore this knob. Requires the native module to be built with the `vad` cargo feature (`cd native && npx napi build --features vad --release`); the default build skips libfvad because its C dep adds 30–60s to clean Rust builds. Functionality win, not perf: libfvad classifies the signal spectrum so background noise / music false-positive far less than `BARGE_IN_RMS_THRESHOLD`. When enabled but the binary lacks the feature, falls back to RMS transparently.
- `ATLAS_VAD_MODE` — 0–3 aggressiveness for `ATLAS_NATIVE_VAD` (0=quality / 3=very aggressive, fewer false positives). Default 2.
- `ATLAS_NO_FORGE` — disables the Skill Forge subsystem entirely (no migration, no library, no synthesis). Phase 1 default-off; flip to default-on after soak (per spec §14).
- `ATLAS_NO_FORGE_LOOKUP` — disables the lookup short-circuit. `create_tool` always proceeds to synthesis. Default-off in Phase 2.
- `ATLAS_NO_FORGE_AUTO_SYNTHESIS` — disables the auto-queue path in `handleToolRequest`. Falls back to the old "you have three options" message.
- `ATLAS_NATIVE_AX` — opt-IN (off by default); routes AX tree flatten/find through `native/src/ax_walker.rs`. Per the empirical Rust rules, JSON round-trip dominates for trees <200 nodes — TS is often faster. Enable only for AX-heavy workloads where the tree is consistently large. Bench TBD before flipping default ON.
- `ATLAS_VISION_PROFILE=lite|standard|full` — override the capability-detector's auto-picked vision-nav profile (`src/screen/capability-detector.ts`). Use for testing the tier-specific code paths or forcing Lite on a workstation.
- `ATLAS_NO_CLICK_MEMORY` — disables persistent click-memory recall/record (`src/screen/click-memory.ts`). On `"true"`, `recallClickSite` returns null and `recordClickSuccess`/`recordClickMiss` are no-ops. Use to rule out a poisoned `data/click-memory.db` as the cause of recurring wrong-target clicks.
- `ATLAS_NO_DRIFT_CALIBRATION` — disables per-monitor drift correction (`src/screen/drift-calibration.ts`). On `"true"`, `recordCalibrationSample` is a no-op and `applyCalibration` returns input unchanged. Use to confirm whether a bad affine fit is causing systematic offset.

### Rust expansion — empirical lessons (May 2026)

The original "push more code to Rust" plan (see `prancy-painting-reef.md`) assumed `more Rust = more speed`. The actual measurements told a tighter story; this section captures it so future contributors don't re-run failed experiments.

**Where Rust wins (ship the port):**
- **Multi-pattern regex sweeps over KB-scale inputs.** The sanitizer fires 23 patterns over shell outputs that range from 1KB to 100KB+. V8's regex engine can't deduplicate scanning across patterns; Rust with sequential `regex::find_iter` + `Cow<&str>` zero-alloc-on-no-match wins 1.44×–2.00× across all input sizes. See `native/src/secrets_sanitizer.rs` for the shape: pattern ordering is load-bearing for parity (sequential, NOT alternation), and the lookahead is emulated with a post-match prefix check to avoid `fancy-regex`.

**Where Rust loses (don't bother porting):**
- **Anything Node has hardware-accelerated.** `node:crypto`'s SHA-256 uses OpenSSL with SHA-NI/ARMv8-crypto extensions. Rust's `sha2` crate is software-only and 2–4× SLOWER. Rust's `blake3` (SIMD-accelerated) ties at best on M-series. Codebase-merkle hashing experiment (May 2026) confirmed this — reverted entirely.
- **Small per-call inputs across an FFI boundary.** napi-rs FFI crossing costs ~500ns–3μs per call. For modules where TS already runs in 1–15μs per call (json-extract, smart-truncate, smartChunkMessage on typical messages, markdownToTelegramHtml), the FFI tax is a meaningful fraction of total time. Net result: Rust is a wash or slower.
- **Graph BFS at small scales.** Spreading-activation BFS over ≤150-node induced graphs (the production ceiling) loses 5×–300×+ to TS because the FFI cost dominates the actual BFS work. Both JSON-string and typed-napi adjacency variants tested; typed was actually ~15% SLOWER (per-property marshalling > serde on small maps). `nativeSpreadActivationBfsTyped` retained as a parity-tested but unused entry point in case future workloads change the crossover.
- **Already-fast file I/O + regex.** repo-map's full scan of the ATLAS repo (~1000 files, regex symbol extraction) completes in 38ms in TS thanks to OS file cache + V8 JIT. Rayon-parallelized Rust would shave ~25ms — not worth a 587-line port.

**The rule going forward.** Before porting a module to Rust, time the TS impl on production-representative input. Only port when **(a) the TS impl is genuinely slow** (>>100μs per call AND on a hot path) AND **(b) Rust has a structural advantage** (multi-pattern scanning Node can't share-state across, or parallelism Node's single-thread can't match). If either condition fails, the FFI tax + maintenance cost makes the port a net negative.

**Caveat — perf rule only.** This is the perf-driven port decision. Correctness or safety wins (e.g. the tree-sitter 0.22 multi-grammar bug, fixable either by porting to the Rust `tree-sitter` crate or by upgrading once the upstream Node binding is patched) are separately justified and don't need to meet the speed criteria above.

**Rollout pattern.** New native ports ship with a kill-switch defaulting to OPT-IN (off) so production behavior is unchanged on day 1. After `scripts/bench-native.ts` shows a measured win across representative inputs AND the parity test passes byte-identical against the TS reference, flip the kill-switch default to ON (rename `ATLAS_NATIVE_X` → `ATLAS_NO_NATIVE_X`). The sanitizer arc — commit `c2fab4f` (opt-in default-off) → `883a594` (default-ON after the `Cow<&str>` rewrite) — is the canonical example.

The `scripts/bench-native.ts` harness lives to enforce this: every native module ships with a per-case bench AND an in-process parity vitest test (`*.parity.test.ts`) that runs both impls on every `npm test`. The `bench-native.ts --parity-check` mode is the larger reference battery — run it manually before flipping the kill-switch default.

## Key Patterns

- **ES Modules** throughout (`"type": "module"`, `NodeNext` module resolution)
- **Fail-open architecture**: Native module unavailable → JS fallback; memory crash → agent continues without persistence; tool not found → skip and try next approach
- **Semantic over keyword**: Tool selection, query classification, and memory recall all use transformer embeddings + cosine similarity, not regex/heuristics
- **Parallelization with ordering**: Memory retrieval all parallel; browser tools sequential, others parallel; boot I/O non-blocking where possible
- **Token budget injection**: All memory snippets have caps (traits: 600 tokens, total injection: ~2-3K tokens) to avoid prompt bloat
- **Cascade escalation**: Errors accumulate → auto-upgrade to higher-cost model tier (now works in sub-agents too, not just main agent)
- **Multi-layer caching**: LLM responses cached semantically (embedding similarity), tool results cached per-tool with TTLs (web_search: 2min, read_file: 1min, system_info: 5min), memory queries cached via temporal cache with bloom filter
- **Graceful shutdown**: All subsystems have cleanup handlers
- **Dependency injection**: `LLMClient` is created once at boot and passed into agent, tools, swarm, and research — never imported as a singleton
- **OpenAI-compatible types**: All LLM interactions use `openai` package types (`ChatCompletionMessageParam`, `ChatCompletionTool`) regardless of actual provider, since Convex proxies through OpenRouter
- **Copyright headers**: All source files carry `© 2024-2026 XAGI Labs Private Limited` proprietary headers
- **Plan-mode state is a runtime gate**: `plan`/`spec`/`awaiting_approval` each have an explicit `*_ALLOWED_TOOLS` in `src/agents/plan-mode.ts`; `filterToolsFor*` strips tools BEFORE the LLM call, `checkWritePathInApprovalMode()` enforces at execution time. Adding a new state: extend the union type, add allowlist, add filter fn, wire into `isToolAllowedInCurrentMode`
- **Structured debug logs**: coding tools emit `logToolAction()` from `src/utils/debug-log.ts`. Format: `🔧 [tool] ctx | path:line — action`. Silence with `ATLAS_TOOL_DEBUG=false`

<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->
