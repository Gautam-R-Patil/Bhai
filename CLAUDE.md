# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A.T.L.A.S (v0.2.0) is a continuously running, proactive personal AI agent built with Node.js/TypeScript (~285 .ts files) + a native Rust performance layer (~49 .rs files). It provides autonomous computer use, deep research, and long-running async workflows via Telegram, Discord, Slack, Matrix, WhatsApp, desktop overlay, and email channels.

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

# Convex backend
npx convex dev           # Start Convex dev server (watches convex/ for changes)
npx convex deploy        # Deploy Convex backend to production

# Desktop app (Electron 40+, electron-builder)
cd desktop && npm start           # Run locally
cd desktop && npm run build:mac   # Build macOS DMG (uses create-dmg.sh)
cd desktop && npm run build:win   # Build Windows NSIS installer
```

Requires Node.js >= 20. No test suite or CI/CD pipeline exists. Linting via Biome (`npm run lint`). The build is just `tsc` + native Rust compilation.

## Architecture

### LLM Client (`src/llm.ts` + `src/crypto-transport.ts`)
All LLM calls are proxied through the Convex backend — the client never holds API keys. Flow:
1. `createLLMClient()` returns an `LLMClient` with a `.chat()` method
2. `.chat()` builds a message array with dynamic context (clock, widget hints) and sends it to `${convexSiteUrl}/api/llm/chat`
3. Transport uses ECDH P-256 key exchange + AES-256-GCM encryption (`encryptedFetch()`) on top of HTTPS
4. Server prepends its own system prompt (from `convex/systemContent.ts`) before forwarding to the LLM provider

Models are defined in `MODELS` constant (Opus, Sonnet, Haiku, GPT-5.x, Gemini). The `LLMClient` interface is injected into the agent, tools, swarm, and research subsystems.

Additional client-side layers injected in `.chat()`:
- **Semantic response cache** (`llm-cache.ts`) — Embedding-based similarity cache (cosine > 0.95 for hit, 10min TTL, 200 entries LRU). Only caches simple queries without tool calls or thinking mode.
- **Adaptive language matching** (`language.ts`) — Detects user language via Unicode script analysis + keyword heuristics, injects "Respond in {language}" instruction. Supports Devanagari, CJK, Cyrillic, Arabic, Hangul, Thai, and Latin-script languages (Spanish, French, German, etc.) including Romanized Hindi/Hinglish.

### Boot Sequence (`src/index.ts`)
Initialization is ordered and partially parallelized:
1. **Session + Auth**: `initSession()` creates Convex auth token, then `initAccountGuard()` verifies credits
2. **Memory**: SQLite databases, knowledge graph, traits, emotional state, episodic memory, self-state
3. **Async warmup (non-blocking)**: Embedding model warmup (`warmupEmbeddings()`), memory semantic migration (`embedExistingMemories()`) — failures are logged but non-fatal
4. **Tool infrastructure**: MCP servers, skills loader, browser memory, Docker sandbox, plugin system, tool router (pre-computes category embeddings)
5. **Channels**: Canvas WebSocket, Google APIs, overlay chat, email (IMAP/SMTP), Telegram bot
6. **Scheduled tasks**: Heartbeat, memory decay (every 6h), dream replay (nightly at 3am)

### Agent Loop (`src/agent.ts:390` — `runAgent()`)
The core execution engine. Flow per invocation:
1. Account gate check (credits)
2. Message preprocessing + context pruning
3. **First iteration only**: 12 memory retrieval systems fire in parallel (identity, traits, session summary, self-state, emotional context, episodic milestones, relationship tone, anticipation signals, core memory, query-specific recall, task learnings, knowledge graph entities) — each has a token budget (~2-3K tokens total injection)
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
All local SQLite (`data/memories.db`). Key subsystems:
- `sqlite.ts` — Primary store: `remember()`, `recall()`, `getCoreMemory()`
- `knowledge-graph.ts` — Entity-relationship graph (people, tools, preferences)
- `vector-index.ts` — HNSW approximate nearest neighbor for semantic recall
- `reflection.ts` — Nightly dream replay consolidates learnings; decay runs every 6h
- `task-learnings.ts` — Persists strategies for recurring task types
- `identity.ts`, `traits.ts`, `emotional.ts`, `episodic.ts`, `self-state.ts`, `session.ts`, `relationship.ts` — Specialized memory tiers
- `working-memory.ts`, `hopfield-memory.ts` — Short-term working memory and associative recall
- `world-model.ts`, `user-model.ts` — Internal models of world state and user behavior
- `active-inference.ts`, `counterfactual.ts`, `prospective.ts` — Predictive and counterfactual reasoning
- `sleep-gate.ts`, `surprise-gate.ts` — Gating mechanisms for memory consolidation
- `reranker.ts`, `strategy-library.ts` — Retrieval reranking and reusable strategy patterns
- `memory-informed-planning.ts` — Memory-driven plan generation
- `classifier.ts`, `context-pruning.ts` — Query classification and context window management
- `goals.ts` — Goal tracking and persistence
- `self-evolving.ts`, `self-model.ts` — Self-evolving memory and agent self-model
- `consolidation.ts` — Memory consolidation pipeline
- `multimodal.ts` — Multimodal memory storage
- `temporal-cache.ts` — Bloom-filter temporal cache for memory queries
- `embeddings.ts`, `multimodal-embedding.ts` — Embedding generation for text and multimodal inputs

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
SIMD-accelerated vector operations (~15-20x speedup) via napi-rs. Built with `opt-level=3`, LTO, `panic=abort`, stripped binaries. Key dependencies: `wide` (SIMD), `simsimd` (similarity), `rayon` (parallelism), `aes-gcm` (encryption). Key modules grouped by role:
- **Core / infra**: `lib.rs` (napi-rs entry point), `agent_core.rs`, `vector.rs`, `batch.rs`, `security.rs`
- **Routing & classification**: `model_router.rs`, `tool_router.rs`, `tool_analytics.rs`, `query_classifier.rs`, `context_pruning.rs`
- **Memory backbone**: `memory_state.rs`, `memory_tiers.rs`, `session_memory.rs`, `knowledge_graph.rs`, `spreading.rs`, `hnsw.rs`, `temporal_cache.rs`, `consolidation.rs`, `reflection_core.rs`
- **Memory gating & associative**: `hopfield.rs`, `working_memory.rs`, `sleep_gate.rs`, `surprise_gate.rs`, `traits_engine.rs`, `task_learnings.rs`
- **Agent orchestration**: `swarm.rs`, `mesh.rs`, `sub_agent.rs`, `long_task.rs`
- **Reasoning engines**: `metacognition.rs`, `active_inference.rs`, `mcts_engine.rs`, `logic_engine.rs`, `prompt_evaluator.rs`, `pattern_speculator.rs`, `process_reward.rs`
- **Predictive models**: `world_model.rs`, `user_model.rs`, `credibility_model.rs`
- **Proactive counterparts**: `inner_thoughts.rs`, `goal_engine.rs`, `notification_tracker.rs`, `habit_detector.rs`
- **Specialized scoring/analysis**: `skill_scorer.rs`, `info_gain.rs`, `citation_graph.rs`, `research_engine.rs`
- **Integration**: `chrome_bridge.rs` (Chrome extension bridge)

### Agent Orchestration (`src/agents/` — 26 files)
Four-tier execution model for tasks of increasing complexity, with extensive reliability, optimization, and self-improvement layers:

**Core Execution Tiers:**
- **Sub-Agent** (`sub-agent.ts`) — Specialized roles (researcher, coder, browser, system, general) with role-specific prompting, scoped tool access, loop detection (#11), error-driven model escalation (#13), smart tool output truncation (#3), dynamic tool expansion via `request_tools` meta-tool (#12), priority-based timeout/model scaling (#4), partial result streaming (#19), and per-iteration cost tracking (#16)
- **Swarm** (`swarm.ts`) — Decomposes complex tasks into sub-agent steps (max 20), executes via Mesh, synthesizes results with evaluator-optimizer loop (#7), supports replanning (#6), integrates task learnings from past executions (#18). Triggered by `swarm_task` tool
- **Mesh** (`mesh.ts`) — Parallel DAG execution engine with: critical path scheduling (#4, assigns priority to steps on the longest dependency chain), layered error recovery (#1, retry→rephrase→reroute→skip), structured handoff messages (#2, replaces raw output concatenation), dynamic role assignment (#5, keyword-based role override)
- **Long-Task** (`long-task.ts`) — Multi-phase executor. 200 iterations/phase, 30 min timeout/phase, max 100 phases. Checkpoints to `data/long-tasks/${taskId}.json` every 60s. Supports inter-phase replanning (#10, max 3 replans per task with early completion detection)

**Reliability Layers** (`src/agents/`):
- `error-recovery.ts` — Multi-level recovery chain: retry (exponential backoff) → rephrase (append error context) → reroute (switch agent role) → skip (propagate failure context)
- `error-types.ts` — Typed error classification: `ErrorCategory` enum (Transient, Permanent, ResourceLimit, ToolMissing, ParseError, Timeout, UserCaused) with pattern matching
- `smart-truncate.ts` — Tool-specific output truncation: shell (tail-heavy for errors), JSON (parse+prune values), browser (keep element IDs), files (head+tail)
- `handoff.ts` — Structured inter-agent context: summary (300 chars), key findings (5 bullets), artifact refs, errors — replaces raw output concatenation

**Optimization Layers** (`src/agents/`):
- `evaluator.ts` — Quality scoring (completeness/accuracy/coherence/actionability 0-100) with retry-on-low-score loop
- `replanner.ts` — Analyzes intermediate results, revises remaining plan when failures or new information detected
- `role-analyzer.ts` — Keyword-based role classifier, overrides LLM-assigned roles when confidence > 0.7
- `mixture.ts` — Mixture of Agents: parallel synthesis proposals + aggregation for complex tasks (>= 5 steps)
- `speculative.ts` — Races primary + alternative approaches for uncertain steps, first success wins
- `decomposition-library.ts` — Saves/reuses successful task decomposition templates (`data/decomposition-templates.json`)
- `blackboard.ts` — Per-swarm shared mutable context for cross-agent discovery sharing
- `complexity-classifier.ts` — Analyzes message complexity, injects hints for swarm/long-task usage

**Self-Improvement & Specialized Agents** (`src/agents/`):
- `metacognition.ts` — Agent self-monitoring and reasoning-about-reasoning
- `multi-critic.ts` — Multiple independent critics evaluate agent output
- `textgrad-refiner.ts` — Gradient-style iterative refinement of text outputs
- `self-editor.ts` — Agent self-edits its own outputs before delivery
- `code-action-agent.ts` — Specialized agent for code generation and execution
- `computer-use-agent.ts` — Specialized agent for GUI/desktop interaction tasks
- `self-heal.ts` — Self-healing: detects and recovers from agent-level failures

### Browser Tools (`src/tools/browser/` — 15 files; `src/tools/` has ~45 top-level tool files, ~60 total)
Dual-backend browser automation. The `BrowserBackend` interface (`browser-backend.ts`) abstracts over two engines:
- **Playwright** (`playwright-backend.ts`) — Headless Chromium for automated browsing, persistent profile in `data/browser-profile/`
- **Chrome Extension** (`chrome-backend.ts` + `chrome-bridge.ts`) — WebSocket bridge to user's real Chrome browser via companion extension, no headless browser needed; `ChromePageProxy` class mimics Playwright's Page API surface
- `stagehand-bridge.ts` — AI-native browser framework integration
- `mode-tools.ts` — Switches agent between fast (DOM-only) and vision (screenshot + OCR) modes
- `profile-sync.ts` — Browser profile synchronization
- 25+ browser actions exposed: navigate, click, type, scroll, extract, parallel tabs/actions, upload, JS execution, strategy save/recall

### Tool Intelligence (`src/tools/tool-intelligence.ts` + `tool-fabricator.ts` + `create-tool.ts`)
- **Tool intelligence** — Per-tool caching (TTL-based: web_search 2min, read_file 1min, system_info 5min), rate limiting, audit logging, confirmation gates
- **Tool fabricator** — Autonomous tool creation when no existing tool matches a task: searches for APIs/docs → generates implementation → sandbox tests → persists
- **Dynamic tools** (`create-tool.ts`) — User-created tools that persist to `~/.atlas/store/tools` and hot-reload at runtime

### Deep Research (`src/research/` — 11 files)
Background research engine with its own execution loop:
- `engines.ts` — Search provider abstraction (web search, specialized sources)
- `executor.ts` — Manages research loop (up to 500 sources)
- `fetcher.ts` — Content extraction and HTML→text conversion
- `scoring.ts` — Relevance scoring for retrieved content
- `persistence.ts` — Saves results to `data/research/` as markdown files
- `hypothesis-engine.ts` — Generates and tests research hypotheses
- `credibility-model.ts` — Source credibility assessment
- `analysis.ts` — Deep analysis of research findings
- `profiles.ts` — Research profile management

### Runtime Data (`data/`)
All runtime artifacts live in the `data/` directory (gitignored):
- `data/memories.db` — SQLite database for all memory subsystems
- `data/long-tasks/` — Checkpoint JSON files for resumable long tasks
- `data/research/` — Saved research results (markdown)
- `data/browser-profile/` — Persistent Playwright browser profile (cookies, cache)
- `data/google-credentials.json` + `data/google-tokens/` — Google API OAuth tokens

### Social Cognition (`src/social/` — 4 files)
Models for understanding and adapting to users socially:
- `theory-of-mind.ts` — Tracks user's mental state: knowledge, beliefs, goals, expectations. Informs response framing
- `emotion-detector.ts` — Detects user emotional state from message content
- `pragmatics.ts` — Pragmatic language understanding (implicature, indirect requests)
- `persuasion.ts` — Ethical persuasion strategies for recommendations

### Planning & Execution (`src/planning/` + `src/execution/`)
Advanced planning beyond simple swarm decomposition:
- `mcts-planner.ts` — Monte Carlo Tree Search for agent planning (inspired by ReST-MCTS*, ToolTree). UCB1 balances exploration/exploitation, nodes scored by Process Reward Model
- `hierarchical-planner.ts` — Multi-level plan decomposition
- `process-reward.ts` — Step-level reward model for plan quality assessment
- `logic-verifier.ts` — Formal verification of plan logical consistency
- `pattern-speculator.ts` (`src/execution/`) — Speculative pattern execution

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
- **Alive UX** — Centralized personality/phrasing system. Phrase history prevents repetition; adapts tone to time-of-day, user mood, task type
- **Network Health** — Monitors connectivity (online/degraded/offline); subsystems check `isOnline()` before network calls. 45s passive checks, faster 15s recovery checks when offline
- **Location** (`src/location/` — 7 files) — Singleton location service matching the `network-health.ts` pattern. Fail-open GPS → Wi-Fi → IP fallback chain via pluggable providers in `src/location/providers/`. Swift CoreLocation helper is built via `npm run build:location` (`scripts/get_location.swift` → `scripts/get_location_bin`) and invoked by the GPS provider on macOS. `network-watcher.ts` drives refresh on connectivity changes

### Widget (`src/widget/widget.ts`)
Self-contained embeddable chat widget served as `/widget.js` from the overlay server. A single IIFE injects its own DOM + styles + WebSocket logic, authenticates via `?token=` query param, and connects to the overlay WebSocket to give any webpage a floating chat bubble.

### Additional Subsystems
- **MCP** (`src/mcp/`) — Model Context Protocol server integration (`client.ts`, `gitmcp-bridge.ts`); loads external tool providers at boot
- **Plugins** (`src/plugins/`) — Plugin system for extending agent capabilities
- **Proactive** (`src/proactive/` — 14 files) — Heartbeat engine, proactive behaviors, and automated night dreaming (`dreaming.ts`). Additionally: `goal-engine.ts` (autonomous goal generation, bi-level outer/inner loops), `habit-detector.ts` (detects user behavior patterns), `inner-thoughts.ts` (agent internal monologue), `thought-journal.ts`, `trigger-detector.ts`, `notification-tracker.ts`, `environment-sensors.ts`, `proactive-reward.ts`, `dnd.ts` (do-not-disturb management), `monitors.ts`, `activity.ts`, `recommendations.ts`
- **Security** (`src/security/`) — Sandboxing (`sandbox.ts`), input validation (`allowlist.ts`), secrets detection (`secrets.ts`), Docker isolation logic
- **Voice** (`src/voice/`) — Voice message processing (`telegram-voice.ts`), TTS (`tts.ts`, `elevenlabs.ts`), wake word detection (`wake-word.ts`), live voice mode (`talk-mode.ts`, `live/`), transcription (`transcribe.ts`)
- **Canvas** (`src/canvas/`) — WebSocket-based canvas channel for rich UI interactions
- **Commands** (`src/commands/`) — Slash-command parsing for Telegram/overlay input
- **Skills Loader** (`src/skills/`) — Loads skill files (gray-matter frontmatter markdown from `skills/` and `~/.atlas/store/skills`) into agent context based on task type
- **Store** (`src/store/`) — Skill marketplace / store functionality with hot-reload (`hot-reload.ts`), sideloading (`sideload.ts`)
- **Additional Channels** — Discord (`src/discord.ts`), Slack (`src/slack.ts`), Matrix (`src/matrix.ts`)
- **Config** (`src/config/`) — Centralized config: API keys (`keys.ts`), filesystem paths (`paths.ts`), protected config loading (`protected-loader.ts`)
- **Notifications** (`src/notifications/`) — Push notification delivery (`push.ts`)
- **LLM Middleware** (`src/llm-middleware.ts`) — Middleware layer between LLM client and agent
- **Types / Utils** (`src/types/`, `src/utils/`) — Ambient type declarations (`qrcode-terminal.d.ts`, `sql.js.d.ts`) and shared utilities (`json-extract.ts` for robust LLM JSON parsing, `system-resources.ts`, `uuid.ts`)

### WhatsApp Channel (`src/whatsapp.ts` + `src/whatsapp-users.ts`)
WhatsApp is the most privilege-differentiated channel. It uses Baileys (`@whiskeysockets/baileys`) and splits every inbound message into one of four flows based on sender identity. State lives in `data/whatsapp-users/` (owners, contacts, personas, groups as JSON files) — **not** in `data/memories.db`.

**Identity tiers** (resolved per message in `whatsapp-users.ts`):
- **Owner** — JID registered via verification handshake (`addOwner`, stored in `owners.json`). Full agent access, no tool allowlist, uses `runAgent` with `isOwner: true`. Per-JID conversation history kept in-memory in `ownerConversations` Map (not persisted — rebuilds from contact history on restart).
- **Allowed contact** — Non-owner JID approved by the owner via `allow`/`block` admin commands. Gets persona-gated access (see below).
- **Unknown contact** — First-time sender. Triggers `handleNewContactMessage` → notifies owner with an approval request; if `autoAllow` is on, promotes after a delay.
- **Group** — Group JID (`*@g.us`). Different logic entirely (see Groups below).

**Persona system** (`whatsapp-users.ts` — `WhatsAppBotPersona`):
- Single global persona stored in `whatsapp-persona.json` (name, systemPrompt, `allowedToolNames[]`). Defaults to "Personal Assistant" with a narrow tool allowlist.
- Applied to **all non-owner messages** (contacts + non-owner group participants). Owner messages bypass the persona entirely.
- The contact system prompt (`whatsapp.ts:~933`) hard-codes anti-impersonation rules: never reveal owner info, reject "I am the owner" claims, refuse system actions requested on the owner's behalf. These are in code, not persona config — do not weaken them.

**Groups** (`WhatsAppGroup` in `whatsapp-users.ts`, handlers in `whatsapp.ts`):
- **Add flow** (`groups.upsert` event, `whatsapp.ts:1499`): On group join, fetches `groupMetadata`. If an owner is a participant → auto-approves (`status: "active"`). Otherwise → `status: "pending"` and DMs the first owner with `approve <name>` / `decline <name>` prompts. Groups the bot was added to by non-owners are silent until the owner explicitly approves — this is the "group non-owner add" protection.
- **Status lifecycle**: `pending` → `active` (via `approveGroup`) → optionally `muted` (via `muteGroup`; observes silently but logs messages). Owner admin commands: `approve X`, `decline X`, `groups`, `mute group X`, `unmute group X`.
- **Per-group state**: `messageHistory` (rolling), `participants` (per-JID message counts), `tone`, `description`, `totalMessageCount`, `botMessageCount`, `lastBotMessage`. Each group has its own memory scope (`group:${groupJid}`) for `recall()`.
- **Response gating** (`handleGroupMessage`, `whatsapp.ts:1033`). In order:
  1. Group must be `active` (pending/muted → drop).
  2. **Always respond** if directly mentioned (`/\batlas\b|a\.t\.l\.a\.s/i`) or replied-to via quoted-message contextInfo.
  3. Otherwise throttle: skip if `<30s` since last bot message.
  4. Don't dominate: skip if bot sent `>15%` of total group messages (after 20+ messages).
  5. **LLM-driven chime-in decision**: a Haiku call (`modelOverride: "anthropic/claude-haiku-4.5"`) reads the last 10 messages and returns `YES`/`NO`; only `YES` proceeds. Failure = silent (safe default).
- **Tool allowlist in groups**: `senderIsOwner ? undefined : getPersona().allowedToolNames`. Owners get full tools even in groups; every other participant is persona-restricted. This is the key "group non-owner" distinction — the same group JID routes to different tool sets depending on who sent the message.
- **Group participant removal** (`group-participants.update`): if the bot itself is removed, the group is deleted from state.
- **Call rejection**: incoming voice/video calls are auto-rejected with a text reply.

### Web Portals (`portals/`)
Both are Next.js + Tailwind CSS apps with their own `package.json` and `.env.example`:
- `portals/admin-panel/` — Admin dashboard for managing users, store submissions, system prompts/skills
- `portals/developer-portal/` — Developer-facing portal for skill/tool/MCP server publishing

### Overlay App (`overlay-app/`)
Native macOS Swift app (`Package.swift`) for the desktop overlay UI (distinct from the inline `src/overlay/overlay.html`).

### Chrome Extension (`chrome-extension/`)
The user-side companion for the Chrome Extension backend (`src/tools/browser/chrome-backend.ts`). Files: `manifest.json`, `background.js` (WebSocket bridge back to the agent), `content.js` (DOM access inside pages), `popup.html`/`popup.js` (user-facing toggle). The agent drives the user's real Chrome instead of a headless browser when this is paired.

### Admin Dashboard / Scripts / Docs
- `admin-dashboard/index.html` — Single-file static dashboard (separate from the full Next.js `portals/admin-panel/`)
- `scripts/` — Build helpers and runtime utilities: `get_location.swift` + `LocationInfo.plist` (CoreLocation helper), `ocr_screen.swift` / `ocr_screen.ps1` (OCR helpers), `grid_overlay.py` / `som_overlay.py` (set-of-marks vision overlays), `atlas-hotkey.ahk` / `atlas-hotkey.lua` (OS hotkey bindings), `seed-store.ts` / `seed-system-content.ts` (Convex DB seeding), `patch-baileys.sh` (runs from `postinstall`)
- `docs/` — Internal documentation (e.g. `docs/superpowers/`)

### Configuration
- Environment variables via `.env` (see `.env.example`)
- Required: `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`, `ATLAS_OTPLESS_USER_ID`
- Optional: `EMAIL_USER`/`EMAIL_PASSWORD`, `EMAIL_WHITELIST`, `GITHUB_TOKEN`, `HF_TOKEN` (for gated embedding models), `MEMORY_DEBUG`
- Optional voice: `LIVE_VOICE_NAME` (Gemini: Aoede/Charon/Kore/Fenrir/Puck; OpenAI: alloy/shimmer/echo), `LIVE_VOICE_BACKEND` (gemini-live/openai-realtime/hybrid)
- OpenRouter and Convex keys are bundled — not user-configurable
- System prompts assembled from `prompts/` directory: `identity.md`, `rules.md`, `rules-mac.md`/`rules-windows.md`, `browsing.md`, `thinking.md`
- Skills loaded from `skills/` (built-in — 12 role markdown files plus 5 Convex-specific skill directories: `convex-create-component`, `convex-migration-helper`, `convex-performance-audit`, `convex-quickstart`, `convex-setup-auth`) and `~/.atlas/store/skills` (user-installed); each role skill is a markdown file with gray-matter frontmatter defining role, triggers, and instructions

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
